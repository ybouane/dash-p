/**
 * dash-p SDK — a drop-in `query()` shaped like @anthropic-ai/claude-agent-sdk,
 * but powered by driving the interactive Claude TUI through a PTY instead of the
 * headless `-p` stream-json protocol.
 *
 *   import { query } from 'dash-p';
 *   for await (const msg of query({ prompt: 'Hello', options: { model: 'sonnet' } })) {
 *     if (msg.type === 'assistant') console.log(msg.message.content);
 *   }
 */
import { randomUUID } from 'node:crypto';
import { DashPEngine } from '../controller/engine.js';
import type { PermissionPolicy } from '../types.js';
import type { TranscriptBlock } from '../types.js';
import { compareScrapedToSession, findSessionFile, readLatestTurn } from '../session/reader.js';
import type {
  ContentBlock,
  Options,
  PermissionMode,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from './types.js';

export * from './types.js';

export function query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  const options = params.options ?? {};
  const sessionId = randomUUID();
  const cwd = options.cwd ?? process.cwd();
  const engine = new DashPEngine({
    claudePath: options.claudePath,
    claudeArgs: buildClaudeArgs(options, sessionId),
    cwd: options.cwd,
    size: options.terminalSize,
    permissionPolicy: permissionModeToPolicy(options.permissionMode),
    onPermission: options.onPermission
      ? async (question, opts) => ({ action: await options.onPermission!(question, opts) })
      : undefined,
    quietMs: options.quietMs,
    reflow: options.reflow,
    debug: options.debug,
  });

  const queue = new AsyncQueue<SDKMessage>();

  // With debug on, stream the engine's log + state transitions to stderr so a
  // stuck startup (a gate, a slow cold start) is visible instead of opaque.
  if (options.debug) {
    engine.on('log', (e: { type: 'log'; level: string; message: string }) =>
      process.stderr.write(`dash-p[${e.level}] ${e.message}\n`),
    );
    engine.on('state', (e: { type: 'state'; prev: string; state: string }) =>
      process.stderr.write(`dash-p[state] ${e.prev} → ${e.state}\n`),
    );
  }

  // Stream token deltas as partial messages when asked.
  if (options.includePartialMessages) {
    engine.on('delta', (e: { type: 'delta'; text: string }) => {
      queue.push(partial(e.text, sessionId));
    });
  }

  // Mirror the engine's state machine onto session_state_changed messages.
  let lastSdkState: 'idle' | 'running' | 'requires_action' | null = null;
  engine.on('state', (e: { type: 'state'; state: string }) => {
    const s = engineToSdkState(e.state);
    if (s && s !== lastSdkState) {
      lastSdkState = s;
      queue.push({ type: 'system', subtype: 'session_state_changed', state: s, uuid: randomUUID(), session_id: sessionId });
    }
  });

  // Honour an external AbortController.
  const onAbort = () => {
    void engine.interrupt().then(() => engine.stop());
    queue.close();
  };
  options.abortController?.signal.addEventListener('abort', onAbort, { once: true });

  // Drive the conversation in the background, pushing messages as they happen.
  (async () => {
    try {
      await engine.start();
      queue.push(initMessage(engine, options, sessionId));

      let turns = 0;
      for await (const text of promptStream(params.prompt)) {
        queue.push(userMessage(text, sessionId));
        // For structured output, append the schema instruction to what we send
        // the TUI (but echo the original prompt as the user message).
        const sendText = options.jsonSchema ? text + schemaInstruction(options.jsonSchema) : text;
        const res = await engine.send(sendText);
        turns++;
        // Map structured blocks → an assistant message (text + tool_use) plus,
        // if any tools ran, a user message carrying the tool_result blocks.
        const { assistant, toolResults } = buildTurnMessages(
          res.blocks,
          res.text,
          options.model,
          sessionId,
          turns,
        );
        queue.push(assistant);
        if (toolResults) queue.push(toolResults);

        // Field order mirrors `claude -p --output-format json` for clean diffs.
        const result: SDKResultSuccess = {
          type: 'result',
          subtype: 'success',
          is_error: false,
          api_error_status: null,
          duration_ms: res.durationMs,
          duration_api_ms: res.metrics?.durationSec ? res.metrics.durationSec * 1000 : res.durationMs,
          ttft_ms: res.ttftMs,
          num_turns: turns,
          result: res.text,
          stop_reason: res.degraded ? null : 'end_turn',
          session_id: sessionId,
          total_cost_usd: null, // not in the transcript; the CLI computes it from pricing
          permission_denials: [],
          terminal_reason: 'completed',
          uuid: randomUUID(),
          degraded: res.degraded,
          confidence: res.confidence,
        };
        // Scraped usage (output tokens from the footer — approximate).
        if (res.metrics?.outputTokens !== undefined) {
          result.usage = { input_tokens: 0, output_tokens: res.metrics.outputTokens };
          result.usage_source = 'scraped';
        }
        // Bucket 3 (sparse, opt-in): enrich/verify against the on-disk session.
        if (options.enrichFromSession || options.verifySession) {
          applySessionData(result, res.text, sessionId, cwd, options, (m) =>
            process.stderr.write(`dash-p[session]: ${m}\n`),
          );
        }
        if (options.jsonSchema) {
          const parsed = tryParseJson(res.text);
          if (parsed !== undefined) result.structured_output = parsed;
        }
        queue.push(result);
      }
      queue.close();
    } catch (err) {
      queue.fail(err instanceof Error ? err : new Error(String(err)));
    } finally {
      options.abortController?.signal.removeEventListener('abort', onAbort);
      await engine.stop();
    }
  })();

  // Compose the async generator with the SDK control methods.
  const iterator = queue[Symbol.asyncIterator]();
  const gen: AsyncGenerator<SDKMessage, void> = {
    next: () => iterator.next(),
    return: async (v?: unknown) => {
      await engine.stop();
      queue.close();
      return { value: undefined, done: true } as IteratorResult<SDKMessage, void>;
    },
    throw: async (e?: unknown) => {
      await engine.stop();
      throw e;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  const control = {
    interrupt: () => engine.interrupt(),
    setPermissionMode: async (mode: PermissionMode) => {
      engine.setPermissionPolicy(permissionModeToPolicy(mode));
    },
    setModel: async (model?: string) => {
      // Best-effort live switch via the `/model` slash command (see engine).
      await engine.setModelLive(model);
    },
  };

  return Object.assign(gen, control) as Query;
}

// ---- mapping helpers ----

function buildClaudeArgs(o: Options, sessionId: string): string[] {
  const args: string[] = [];
  // Use our generated id as the real session id so the on-disk JSONL matches.
  args.push('--session-id', sessionId);
  // Un-collapse tool output so the scraper sees full results (default on).
  if (o.verbose !== false) args.push('--verbose');
  if (o.model) args.push('--model', o.model);
  if (o.agent) args.push('--agent', o.agent);
  if (o.systemPrompt) args.push('--system-prompt', o.systemPrompt);
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  if (o.allowedTools?.length) args.push('--allowed-tools', ...o.allowedTools);
  if (o.disallowedTools?.length) args.push('--disallowed-tools', ...o.disallowedTools);
  if (o.additionalDirectories?.length) args.push('--add-dir', ...o.additionalDirectories);
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  if (o.mcpServers?.length) args.push('--mcp-config', ...o.mcpServers);
  if (o.agents) args.push('--agents', JSON.stringify(o.agents));
  if (o.settings) args.push('--settings', o.settings);
  if (o.settingSources) args.push('--setting-sources', o.settingSources);
  if (o.betas?.length) args.push('--betas', ...o.betas);
  // NB: --json-schema is print-only and ignored by the interactive TUI, so we
  // don't pass it; structured output is requested via prompt augmentation
  // (see schemaInstruction) and parsed from the answer instead.
  if (o.extraArgs?.length) args.push(...o.extraArgs);
  return args;
}

function schemaInstruction(schema: Record<string, unknown>): string {
  return (
    '\n\nRespond with ONLY a single JSON object that conforms to this JSON Schema. ' +
    'Output raw JSON — no prose, no explanation, no code fences:\n' +
    JSON.stringify(schema)
  );
}

/** Map an engine state to the SDK's session-state vocabulary. */
function engineToSdkState(state: string): 'idle' | 'running' | 'requires_action' | null {
  switch (state) {
    case 'submitting':
    case 'thinking':
    case 'streaming':
      return 'running';
    case 'ready':
    case 'complete':
      return 'idle';
    case 'tool_permission':
    case 'menu':
      return 'requires_action';
    default:
      return null;
  }
}

function tryParseJson(text: string): unknown {
  // Tolerate a fenced ```json block or surrounding prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Bucket 3: enrich the result from / verify it against the on-disk session JSONL.
 * Read-only and opt-in. The JSONL is ground truth, so when present its usage and
 * structured tool input replace the scraped approximations.
 */
function applySessionData(
  result: SDKResultSuccess,
  scrapedText: string,
  sessionId: string,
  cwd: string,
  options: Options,
  warn: (m: string) => void,
): void {
  const file = findSessionFile(sessionId, cwd);
  if (!file) {
    warn('verify/enrich requested but no session JSONL found on disk');
    return;
  }
  if (options.verifySession) {
    const cmp = compareScrapedToSession(scrapedText, file);
    if (cmp.found && !cmp.match) {
      warn(`scraped text diverges from session JSONL (similarity ${cmp.similarity.toFixed(2)})`);
    }
  }
  if (options.enrichFromSession) {
    const turn = readLatestTurn(file);
    if (turn) {
      // The JSONL text is the model's exact output (markdown syntax intact),
      // which the rendered-then-scraped text can't fully preserve. Opting into
      // enrichment means you want that exact form.
      if (turn.text) result.result = turn.text;
      // Exact usage: the rich shape from the final message, with summed token
      // counts overlaid (matches `claude -p` for single-turn; close for tools).
      result.usage = { ...(turn.rawUsage ?? {}), ...turn.usage } as typeof result.usage;
      result.usage_source = 'session';
      if (turn.stopReason) result.stop_reason = turn.stopReason;
    }
  }
}

function permissionModeToPolicy(mode: PermissionMode | undefined): PermissionPolicy {
  switch (mode) {
    case 'bypassPermissions':
    case 'acceptEdits':
    case 'auto':
      return 'allow';
    case 'dontAsk':
      return 'deny';
    default:
      return 'ask';
  }
}

async function* promptStream(prompt: string | AsyncIterable<SDKUserMessage>): AsyncGenerator<string> {
  if (typeof prompt === 'string') {
    yield prompt;
    return;
  }
  for await (const m of prompt) {
    yield extractText(m.message.content);
  }
}

function extractText(content: SDKUserMessage['message']['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b.type === 'text' && 'text' in b ? String((b as { text: string }).text) : ''))
    .join('');
}

// ---- message constructors ----

function initMessage(engine: DashPEngine, o: Options, sessionId: string): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'oauth',
    claude_code_version: engine.currentProfile.generatedFor,
    cwd: o.cwd ?? process.cwd(),
    tools: [],
    mcp_servers: [],
    model: o.model ?? 'default',
    permissionMode: o.permissionMode ?? 'default',
    slash_commands: [],
    output_style: 'default',
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function userMessage(text: string, sessionId: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

/**
 * Turn the engine's structured blocks into SDK messages:
 *  - one `assistant` message whose content is the ordered text + tool_use blocks
 *  - one `user` message carrying the tool_result blocks (paired by order), when
 *    any tools ran — mirroring how the real SDK threads tool results back.
 */
function buildTurnMessages(
  blocks: TranscriptBlock[],
  proseText: string,
  model: string | undefined,
  sessionId: string,
  turnNo: number,
): { assistant: SDKAssistantMessage; toolResults: SDKUserMessage | null } {
  const assistantContent: ContentBlock[] = [];
  const toolUseIds: string[] = [];

  for (const b of blocks) {
    if (b.kind === 'text') {
      assistantContent.push({ type: 'text', text: b.text });
    } else if (b.kind === 'tool_use') {
      const id = `dashp_${turnNo}_${toolUseIds.length}`;
      toolUseIds.push(id);
      assistantContent.push({ type: 'tool_use', id, name: b.name, input: toolInput(b.name, b.args) });
    }
  }
  if (assistantContent.length === 0) assistantContent.push({ type: 'text', text: proseText });

  const resultBlocks = blocks.filter(
    (b): b is { kind: 'tool_result'; text: string; isError?: boolean } => b.kind === 'tool_result',
  );
  let toolResults: SDKUserMessage | null = null;
  if (resultBlocks.length) {
    const content: ContentBlock[] = resultBlocks.map((b, i) => ({
      type: 'tool_result',
      tool_use_id: toolUseIds[i] ?? `dashp_${turnNo}_${i}`,
      content: b.text,
      ...(b.isError ? { is_error: true } : {}),
    }));
    toolResults = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: sessionId,
    };
  }

  const assistant: SDKAssistantMessage = {
    type: 'assistant',
    message: { role: 'assistant', content: assistantContent, model: model ?? 'default' },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
  return { assistant, toolResults };
}

/**
 * Map a tool's rendered args into a best-effort structured `input`. The TUI shows
 * `Name(args)`, not the model's JSON, so for known tools we map the rendered
 * string onto the canonical primary field; unknown tools keep `{ raw }`. Use
 * `enrichFromSession` for the exact model input.
 */
function toolInput(name: string, raw: string): Record<string, unknown> {
  const a = raw.trim();
  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return { command: a };
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { file_path: a.split(',')[0]!.trim(), raw: a };
    case 'Grep':
    case 'Glob':
      return { pattern: a };
    case 'WebFetch':
      return { url: a };
    case 'WebSearch':
      return { query: a };
    case 'Task':
    case 'Skill':
    case 'SlashCommand':
      return { description: a };
    default:
      return { raw: a };
  }
}

function partial(text: string, sessionId: string): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

// ---- async queue bridging events → generator ----

class AsyncQueue<T> {
  private items: T[] = [];
  private waiting: Array<(r: IteratorResult<T>) => void> = [];
  private rejecters: Array<(e: unknown) => void> = [];
  private closed = false;
  private error: unknown = null;

  push(item: T): void {
    if (this.closed) return;
    const resolve = this.waiting.shift();
    if (resolve) {
      this.rejecters.shift();
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    while (this.waiting.length) {
      this.rejecters.shift();
      this.waiting.shift()!({ value: undefined as never, done: true });
    }
  }

  fail(error: unknown): void {
    this.error = error;
    while (this.rejecters.length) {
      this.waiting.shift();
      this.rejecters.shift()!(error);
    }
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve, reject) => {
      this.waiting.push(resolve);
      this.rejecters.push(reject);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
