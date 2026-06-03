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
import type {
  ContentBlock,
  Options,
  PermissionMode,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from './types.js';

export * from './types.js';

export function query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  const options = params.options ?? {};
  const sessionId = randomUUID();
  const engine = new DashPEngine({
    claudePath: options.claudePath,
    claudeArgs: buildClaudeArgs(options),
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

  // Stream token deltas as partial messages when asked.
  if (options.includePartialMessages) {
    engine.on('delta', (e: { type: 'delta'; text: string }) => {
      queue.push(partial(e.text, sessionId));
    });
  }

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
        const res = await engine.send(text);
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
        const result: SDKResultMessage = {
          type: 'result',
          subtype: 'success',
          duration_ms: res.durationMs,
          duration_api_ms: res.durationMs,
          is_error: false,
          num_turns: turns,
          result: res.text,
          session_id: sessionId,
          uuid: randomUUID(),
          degraded: res.degraded,
          confidence: res.confidence,
        };
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

function buildClaudeArgs(o: Options): string[] {
  const args: string[] = [];
  if (o.model) args.push('--model', o.model);
  if (o.agent) args.push('--agent', o.agent);
  if (o.systemPrompt) args.push('--system-prompt', o.systemPrompt);
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  if (o.allowedTools?.length) args.push('--allowed-tools', ...o.allowedTools);
  if (o.disallowedTools?.length) args.push('--disallowed-tools', ...o.disallowedTools);
  if (o.additionalDirectories?.length) args.push('--add-dir', ...o.additionalDirectories);
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  if (o.extraArgs?.length) args.push(...o.extraArgs);
  return args;
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
      assistantContent.push({ type: 'tool_use', id, name: b.name, input: { raw: b.args } });
    }
  }
  if (assistantContent.length === 0) assistantContent.push({ type: 'text', text: proseText });

  const resultBlocks = blocks.filter((b): b is { kind: 'tool_result'; text: string } => b.kind === 'tool_result');
  let toolResults: SDKUserMessage | null = null;
  if (resultBlocks.length) {
    const content: ContentBlock[] = resultBlocks.map((b, i) => ({
      type: 'tool_result',
      tool_use_id: toolUseIds[i] ?? `dashp_${turnNo}_${i}`,
      content: b.text,
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
