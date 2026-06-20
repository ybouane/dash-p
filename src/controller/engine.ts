/**
 * Controller — the state machine that drives one or more turns against the TUI.
 *
 * Wiring:  PTY ─data→ emulator ─snapshot→ recognizer ─state→ controller
 *          controller ─keys→ actions ─write→ PTY
 *
 * A poll loop snapshots the emulated screen on a fixed cadence, classifies it,
 * tracks region-masked quiescence, and emits engine events. `send()` runs the
 * per-turn lifecycle: submit → observe start → wait for settle → extract.
 */
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { PtyTransport } from '../transport/pty.js';
import { TerminalEmulator } from '../emulation/terminal.js';
import { Recognizer } from '../recognize/recognizer.js';
import { selectProfile, type Profile } from '../recognize/profile.js';
import { QuiescenceTracker, contentSignature } from '../observe/quiescence.js';
import { Actions } from '../act/actions.js';
import { KEY } from '../act/keys.js';
import type {
  EngineEvent,
  EngineState,
  PermissionDecision,
  PermissionPolicy,
  Recognition,
  ScreenSnapshot,
  TerminalSize,
  TranscriptBlock,
  TurnMetrics,
} from '../types.js';

export interface EngineOptions {
  claudePath?: string;
  claudeArgs?: string[];
  cwd?: string;
  size?: TerminalSize;
  permissionPolicy?: PermissionPolicy;
  /** Override profile version selection; defaults to detected `claude --version`. */
  version?: string;
  /** Quiescence threshold: content must be still this long to count as settled. */
  quietMs?: number;
  pollMs?: number;
  readyTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** Auto-accept the workspace-trust dialog at startup (default true). */
  trustWorkspace?: boolean;
  /** Rejoin TUI-hard-wrapped paragraphs into single lines (default true). */
  reflow?: boolean;
  /** Called for permission prompts when policy is 'ask'. */
  onPermission?: (question: string, options: string[]) => Promise<PermissionDecision>;
  debug?: boolean;
}

export interface TurnResult {
  text: string;
  /** The turn parsed into structured blocks (text + tool_use + tool_result). */
  blocks: TranscriptBlock[];
  /** True when extraction had to fall back to a raw transcript dump. */
  degraded: boolean;
  confidence: number;
  durationMs: number;
  /** Time to first assistant block (ms), scraped from when output first appeared. */
  ttftMs?: number;
  /** Token/duration metrics scraped from the footer during the turn. */
  metrics?: TurnMetrics;
}

type Latest = { snapshot: ScreenSnapshot; recognition: Recognition };

export class DashPEngine extends EventEmitter {
  private readonly opts: Required<Omit<EngineOptions, 'onPermission' | 'version' | 'claudeArgs' | 'cwd'>> &
    Pick<EngineOptions, 'onPermission' | 'version' | 'claudeArgs' | 'cwd'>;
  private transport!: PtyTransport;
  private emulator!: TerminalEmulator;
  private recognizer!: Recognizer;
  private actions!: Actions;
  private profile!: Profile;
  private readonly quiescence = new QuiescenceTracker();

  private writeChain: Promise<void> = Promise.resolve();
  private pollTimer: NodeJS.Timeout | null = null;
  private latest: Latest | null = null;
  private currentState: EngineState = 'launching';
  private submitting = false;
  private turnStarted = false;
  private lastAssistant = '';
  /**
   * Append-only accumulation of streamed prose for the current turn. Because we
   * collect deltas as they arrive, the result stays complete even if the top of
   * a very long answer scrolls out of the emulator's scrollback window.
   */
  private turnTextAcc = '';
  /** Timestamp the first assistant block appeared this turn (for ttft). */
  private turnFirstBlockAt = 0;
  /** Latest non-empty metrics scraped this turn. */
  private turnMetrics: TurnMetrics = {};
  private exited = false;

  constructor(options: EngineOptions = {}) {
    super();
    this.opts = {
      claudePath: options.claudePath ?? 'claude',
      size: options.size ?? { cols: 120, rows: 40 },
      permissionPolicy: options.permissionPolicy ?? 'ask',
      quietMs: options.quietMs ?? 700,
      pollMs: options.pollMs ?? 40,
      readyTimeoutMs: options.readyTimeoutMs ?? 60_000,
      turnTimeoutMs: options.turnTimeoutMs ?? 240_000,
      trustWorkspace: options.trustWorkspace ?? true,
      reflow: options.reflow ?? true,
      debug: options.debug ?? false,
      onPermission: options.onPermission,
      version: options.version,
      claudeArgs: options.claudeArgs,
      cwd: options.cwd,
    };
  }

  emitEvent(e: EngineEvent): void {
    this.emit('event', e);
    this.emit(e.type, e);
  }

  private log(message: string, level: 'debug' | 'info' | 'warn' = 'debug'): void {
    if (level === 'debug' && !this.opts.debug) return;
    this.emitEvent({ type: 'log', level, message });
  }

  /** Spawn Claude in a PTY and wait until the input box is ready. */
  async start(): Promise<void> {
    const version = this.opts.version ?? this.detectVersion();
    const sel = selectProfile(version);
    this.profile = sel.profile;
    this.recognizer = new Recognizer(this.profile, this.opts.reflow);
    this.log(
      sel.drifted
        ? `claude ${version}: no exact profile, using nearest ${sel.file} (${sel.matchedVersion ?? 'default'})`
        : `claude ${version}: using profile ${sel.file}`,
      'info',
    );

    this.transport = new PtyTransport({
      file: this.opts.claudePath,
      args: this.opts.claudeArgs ?? [],
      cwd: this.opts.cwd,
      size: this.opts.size,
      // If dash-p itself runs inside Claude Code, don't let the child inherit
      // nesting markers — it should behave as a fresh top-level session.
      unsetEnv: [
        'CLAUDECODE',
        'CLAUDE_CODE_ENTRYPOINT',
        'CLAUDE_CODE_SSE_PORT',
        'CLAUDE_CODE_SESSION',
        'CLAUDE_CODE_SIMPLE',
      ],
    });
    this.emulator = new TerminalEmulator({
      size: this.opts.size,
      onReply: (data) => this.transport.write(data),
    });
    this.actions = new Actions(this.transport);

    this.transport.on('data', (data: string) => {
      this.writeChain = this.writeChain.then(() => this.emulator.write(data)).catch(() => {});
    });
    this.transport.on('exit', (code: number | null, signal: number | null) => {
      this.exited = true;
      this.emitEvent({ type: 'exit', code, signal });
    });

    this.transport.start();
    this.startPolling();
    await this.waitUntilReady();
    this.log('TUI ready', 'info');
  }

  /**
   * Wait for the input box, auto-clearing startup gates on the way — currently
   * the workspace-trust dialog (whose affirmative option is pre-highlighted, so
   * Enter accepts it). Mimics `-p`, which skips the trust prompt in chosen dirs.
   */
  private async waitUntilReady(): Promise<void> {
    const triggers = this.profile.startup?.trustTriggers ?? [];
    const start = Date.now();
    let acceptedTrust = false;
    while (true) {
      if (this.currentState === 'ready') break;
      // Readiness guard: a confidently-found input box with no interrupt hint
      // means we're ready, even if the recognizer's busy heuristic is ambiguous
      // (e.g. profile drift on a newer TUI). This keeps profile drift a latency
      // problem, never a liveness one.
      const rec = this.latest?.recognition;
      if (rec && rec.matched.includes('input-box') && !rec.matched.includes('busy-marker')) break;

      if (this.exited) throw new Error('engine exited before becoming ready');
      if (Date.now() - start > this.opts.readyTimeoutMs) {
        throw new Error(
          `timed out after ${Math.round(this.opts.readyTimeoutMs / 1000)}s waiting for the input box. ` +
            this.describeScreen(),
        );
      }

      const snap = this.latest?.snapshot;
      if (!acceptedTrust && this.opts.trustWorkspace && snap && triggers.length) {
        const flat = snap.lines.join('\n');
        if (triggers.some((t) => flat.includes(t))) {
          this.log('workspace-trust dialog → accepting (Enter)', 'info');
          this.actions.enter();
          acceptedTrust = true;
          await delay(this.opts.pollMs * 5);
          continue;
        }
      }
      await delay(this.opts.pollMs);
    }
  }

  /** Human-readable snapshot of where the engine is stuck, for error messages. */
  private describeScreen(): string {
    const rec = this.latest?.recognition;
    const snap = this.latest?.snapshot;
    if (!snap) {
      return 'The TUI produced no output at all — check that the `claude` binary launches and is logged in (run `claude` once interactively).';
    }
    const lines = snap.viewport.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
    const tail = lines.slice(-14).join('\n');
    return `Last state=${rec?.state ?? '?'} confidence=${rec?.confidence?.toFixed(2) ?? '?'}. On screen:\n${tail || '(blank)'}`;
  }

  private detectVersion(): string {
    try {
      const out = execFileSync(this.opts.claudePath, ['--version'], { encoding: 'utf8' });
      // "2.1.119 (Claude Code)" -> "2.1.119"
      return out.trim().split(/\s+/)[0] ?? 'default';
    } catch {
      return 'default';
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => this.poll(), this.opts.pollMs);
  }

  private poll(): void {
    if (!this.emulator) return;
    const snapshot = this.emulator.snapshot();
    const recognition = this.recognizer.recognize(snapshot);
    this.latest = { snapshot, recognition };

    // Quiescence on masked content.
    const sig = contentSignature(snapshot, this.profile, recognition.contentRange ?? { start: 0, end: snapshot.lines.length });
    this.quiescence.update(sig);

    // Capture ttft (first assistant block) and roll up the latest metrics.
    if (this.turnStarted || this.submitting) {
      if (this.turnFirstBlockAt === 0 && recognition.blocks.some((b) => b.kind === 'text' || b.kind === 'tool_use')) {
        this.turnFirstBlockAt = Date.now();
      }
      if (recognition.metrics) {
        if (recognition.metrics.outputTokens !== undefined) this.turnMetrics.outputTokens = recognition.metrics.outputTokens;
        if (recognition.metrics.contextTokens !== undefined) this.turnMetrics.contextTokens = recognition.metrics.contextTokens;
        if (recognition.metrics.durationSec !== undefined) this.turnMetrics.durationSec = recognition.metrics.durationSec;
      }
    }

    // Emit streaming deltas (best-effort clean appends) and accumulate them so
    // the final result survives content scrolling out of the buffer.
    if (recognition.assistantText && recognition.assistantText !== this.lastAssistant) {
      if (recognition.assistantText.startsWith(this.lastAssistant)) {
        const delta = recognition.assistantText.slice(this.lastAssistant.length);
        if (delta) {
          this.emitEvent({ type: 'delta', text: delta });
          this.turnTextAcc += delta;
        }
      }
      this.lastAssistant = recognition.assistantText;
    }

    // Map recognizer state to engine state, honouring the submit window.
    let next = recognition.state;
    if (this.submitting && (next === 'ready')) next = 'submitting';
    if (next !== this.currentState) {
      const prev = this.currentState;
      this.currentState = next;
      this.emitEvent({ type: 'state', state: next, prev });
      if (next === 'thinking' || next === 'streaming') {
        this.submitting = false;
        this.turnStarted = true;
      }
      if (next === 'tool_permission' && recognition.permission) {
        this.emitEvent({ type: 'permission', prompt: recognition.permission });
      }
      if (next === 'menu' && recognition.menu) {
        this.emitEvent({ type: 'menu', prompt: recognition.menu });
      }
    }

    this.emitEvent({ type: 'snapshot', snapshot, recognition });
  }

  /** Submit a prompt and resolve when the turn settles. */
  async send(prompt: string): Promise<TurnResult> {
    if (this.exited) throw new Error('engine has exited');
    await this.waitForState((s) => s === 'ready', this.opts.readyTimeoutMs, 'ready (pre-send)');

    const startedAt = Date.now();
    this.lastAssistant = '';
    this.turnTextAcc = '';
    this.turnFirstBlockAt = 0;
    this.turnMetrics = {};
    this.turnStarted = false;
    this.submitting = true;
    this.quiescence.reset();

    // Inject: paste (atomic, popup-free), let the TUI ingest it, then Enter.
    this.actions.paste(prompt);
    await delay(120);
    this.actions.enter();
    this.emitEvent({ type: 'state', state: 'submitting', prev: this.currentState });

    await this.runTurnLoop(startedAt);

    const rec = this.latest?.recognition;
    let text = rec?.assistantText ?? '';
    // Prefer the final clean extraction. Use the accumulated stream only when it
    // is a genuine scroll-out — i.e. it ENDS WITH the still-visible tail (the
    // head scrolled away). If the accumulator merely has extra trailing content
    // (e.g. a transient ghost suggestion leaked in), keep the clean extraction.
    if (!text) {
      text = this.turnTextAcc;
    } else if (this.turnTextAcc.length > text.length && this.turnTextAcc.endsWith(text)) {
      text = this.turnTextAcc;
    }
    let degraded = false;
    if (!text || (rec && rec.confidence < 0.5)) {
      // Fallback: dump the cleaned transcript rather than crash or lie.
      if (this.latest) {
        text = this.recognizer.cleanTranscript(
          this.latest.snapshot,
          this.latest.recognition.contentRange ?? { start: 0, end: this.latest.snapshot.lines.length },
        );
        degraded = true;
        this.log('extraction confidence low — fell back to raw transcript', 'warn');
      }
    }

    const result: TurnResult = {
      text,
      blocks: rec?.blocks ?? [],
      degraded,
      confidence: rec?.confidence ?? 0,
      durationMs: Date.now() - startedAt,
      ttftMs: this.turnFirstBlockAt ? this.turnFirstBlockAt - startedAt : undefined,
      metrics: Object.keys(this.turnMetrics).length ? { ...this.turnMetrics } : undefined,
    };
    this.emitEvent({ type: 'turn-complete', text });
    return result;
  }

  private async runTurnLoop(startedAt: number): Promise<void> {
    let sawStart = false;
    while (true) {
      if (this.exited) return;
      if (Date.now() - startedAt > this.opts.turnTimeoutMs) {
        this.log('turn timed out', 'warn');
        return;
      }
      const rec = this.latest?.recognition;
      const state = this.currentState;

      // Handle interactive prompts mid-turn.
      if (state === 'tool_permission' && rec?.permission) {
        await this.handlePermission(rec.permission.question, rec.permission.options, rec.permission.defaultIndex);
        await delay(this.opts.pollMs * 3);
        continue;
      }

      if (state === 'thinking' || state === 'streaming') {
        sawStart = true;
      }

      // Completion: the model started, the box is back to ready, and the
      // masked content has been still long enough.
      const backToReady = state === 'ready' || state === 'complete';
      if (sawStart && backToReady && this.quiescence.isStable(this.opts.quietMs)) {
        return;
      }

      // Robustness: if we never detected an explicit "busy" (mis-calibrated
      // busy markers) but assistant text appeared and then stabilised, accept it.
      if (!sawStart && this.lastAssistant && backToReady && this.quiescence.isStable(this.opts.quietMs * 2)) {
        this.log('completed without an explicit busy signal (check busyMarkers)', 'warn');
        return;
      }

      await delay(this.opts.pollMs);
    }
  }

  private async handlePermission(question: string, options: string[], defaultIndex: number | null): Promise<void> {
    let action: PermissionDecision['action'];
    switch (this.opts.permissionPolicy) {
      case 'allow':
        action = 'allow';
        break;
      case 'deny':
        action = 'deny';
        break;
      default: {
        if (this.opts.onPermission) {
          action = (await this.opts.onPermission(question, options)).action;
        } else {
          action = 'deny'; // cautious default when nobody is listening
        }
      }
    }
    this.log(`permission "${question}" -> ${action}`, 'info');
    if (action === 'allow') {
      // Affirmative option is usually the highlighted default → Enter.
      this.actions.enter();
    } else if (action === 'deny') {
      this.actions.press(KEY.ESC);
    } else {
      this.actions.interrupt();
    }
  }

  async interrupt(): Promise<void> {
    this.actions?.interrupt();
    await delay(50);
  }

  /**
   * Best-effort live model switch via the `/model <name>` slash command. The TUI
   * may instead open a picker for some inputs; this types the command and Enter,
   * then waits to return to ready. Prefer passing `model` at construction time.
   */
  async setModelLive(model?: string): Promise<void> {
    if (!model) return;
    await this.waitForState((s) => s === 'ready', this.opts.readyTimeoutMs, 'ready (setModel)');
    this.actions.type(`/model ${model}`);
    await delay(150);
    this.actions.enter();
    await delay(300);
    this.log(`requested model switch → ${model} (best-effort)`, 'info');
  }

  private async waitForState(
    pred: (s: EngineState) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<void> {
    const start = Date.now();
    while (!pred(this.currentState)) {
      if (this.exited) throw new Error(`engine exited while waiting for ${label}`);
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}. ${this.describeScreen()}`);
      await delay(this.opts.pollMs);
    }
  }

  get state(): EngineState {
    return this.currentState;
  }

  /** Change how mid-turn permission prompts are handled (used by SDK setPermissionMode). */
  setPermissionPolicy(policy: PermissionPolicy): void {
    this.opts.permissionPolicy = policy;
  }

  get currentProfile(): Profile {
    return this.profile;
  }

  snapshot(): ScreenSnapshot | null {
    return this.latest?.snapshot ?? null;
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    try {
      this.transport?.write(KEY.CTRL_C);
      await delay(40);
    } catch {
      /* ignore */
    }
    this.transport?.kill();
    this.emulator?.dispose();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
