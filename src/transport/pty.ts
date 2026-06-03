/**
 * Transport layer — owns the pseudo-terminal and the child process.
 *
 * This layer knows nothing about Claude or terminals-as-screens. It spawns a
 * program attached to a real PTY (so `isatty()` passes and the child renders
 * its full interactive UI), exposes raw byte I/O, and forwards resize events.
 */
import pty from 'node-pty';
import type { IPty } from 'node-pty';
import { EventEmitter } from 'node:events';
import type { TerminalSize } from '../types.js';

export interface PtyOptions {
  file: string;
  args?: string[];
  cwd?: string;
  size: TerminalSize;
  /**
   * Extra environment. We start from process.env so the child inherits the
   * user's real shell/auth context, then layer fidelity vars on top.
   */
  env?: Record<string, string>;
  /** Env keys to remove from the inherited environment (after merge). */
  unsetEnv?: string[];
}

export class PtyTransport extends EventEmitter {
  private proc: IPty | null = null;
  private exited = false;

  constructor(private readonly opts: PtyOptions) {
    super();
  }

  start(): void {
    if (this.proc) throw new Error('PtyTransport already started');

    // Environment fidelity: present a faithful, modern interactive terminal so
    // the child renders its true TUI rather than degrading to pipe/CI mode.
    // This is terminal emulation correctness, not evasion — and deliberately
    // does NOT set CI=1 (which would suppress the very animations we observe).
    const env: Record<string, string> = {
      ...stringEnv(process.env),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      // Make the column count explicit and stable; the emulator owns reflow.
      COLUMNS: String(this.opts.size.cols),
      LINES: String(this.opts.size.rows),
      ...(this.opts.env ?? {}),
    };

    // Present a fresh top-level session: strip any inherited "I'm running inside
    // Claude Code" markers so the spawned child doesn't think it is nested.
    for (const key of this.opts.unsetEnv ?? []) delete env[key];

    this.proc = pty.spawn(this.opts.file, this.opts.args ?? [], {
      name: 'xterm-256color',
      cols: this.opts.size.cols,
      rows: this.opts.size.rows,
      cwd: this.opts.cwd ?? process.cwd(),
      env,
    });

    this.proc.onData((data: string) => this.emit('data', data));
    this.proc.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.emit('exit', exitCode, signal ?? null);
    });
  }

  /** Write raw bytes to the child's stdin (the PTY master). */
  write(data: string): void {
    if (!this.proc || this.exited) return;
    this.proc.write(data);
  }

  resize(size: TerminalSize): void {
    if (!this.proc || this.exited) return;
    this.proc.resize(size.cols, size.rows);
  }

  kill(signal?: string): void {
    if (!this.proc || this.exited) return;
    try {
      this.proc.kill(signal);
    } catch {
      /* already gone */
    }
  }

  get isAlive(): boolean {
    return !!this.proc && !this.exited;
  }
}

/** Drop undefined values so the env satisfies Record<string,string>. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}
