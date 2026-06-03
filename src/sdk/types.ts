/**
 * A faithful *subset* of @anthropic-ai/claude-agent-sdk's public types.
 *
 * The shapes mirror the real SDK (same discriminants, same key field names) so
 * code written against `query()` ports over for the common path. Fields the TUI
 * can't observe are marked optional or omitted; see docs/SDK-PARITY.md for the
 * full divergence list. This file intentionally avoids importing the Anthropic
 * SDK so dash-p stays dependency-light.
 */

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

export type UUID = string;

/** Loose content-block shape compatible with Anthropic message content. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export interface APIMessage {
  role: 'assistant' | 'user';
  content: ContentBlock[] | string;
  model?: string;
  id?: string;
  stop_reason?: string | null;
}

export interface SDKSystemMessage {
  type: 'system';
  subtype: 'init';
  apiKeySource: 'user' | 'project' | 'org' | 'temporary' | 'oauth';
  claude_code_version: string;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
  uuid: UUID;
  session_id: string;
}

export interface SDKAssistantMessage {
  type: 'assistant';
  message: APIMessage;
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
}

export interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: ContentBlock[] | string };
  parent_tool_use_id: string | null;
  uuid?: UUID;
  session_id?: string;
}

/** Streaming token deltas. `event` mirrors a Beta raw message stream event. */
export interface SDKPartialAssistantMessage {
  type: 'stream_event';
  event: StreamEvent;
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
}

export type StreamEvent =
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } }
  | { type: string; [k: string]: unknown };

export interface SDKResultSuccess {
  type: 'result';
  subtype: 'success';
  duration_ms: number;
  duration_api_ms: number;
  is_error: false;
  num_turns: number;
  result: string;
  session_id: string;
  uuid: UUID;
  /** dash-p extension: true when extraction fell back to a raw transcript. */
  degraded?: boolean;
  /** dash-p extension: recognizer confidence for this turn (0..1). */
  confidence?: number;
}

export interface SDKResultError {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns';
  duration_ms: number;
  duration_api_ms: number;
  is_error: true;
  num_turns: number;
  result?: string;
  session_id: string;
  uuid: UUID;
}

export type SDKResultMessage = SDKResultSuccess | SDKResultError;

export type SDKMessage =
  | SDKSystemMessage
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKPartialAssistantMessage
  | SDKResultMessage;

/** Subset of the SDK Options, mapped onto Claude CLI flags + engine config. */
export interface Options {
  abortController?: AbortController;
  additionalDirectories?: string[];
  agent?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  cwd?: string;
  model?: string;
  /** Maps to --system-prompt. */
  systemPrompt?: string;
  /** Maps to --append-system-prompt. */
  appendSystemPrompt?: string;
  permissionMode?: PermissionMode;
  /**
   * dash-p's equivalent of `canUseTool`: called when the TUI shows a permission
   * prompt and `permissionMode` resolves to "ask". Return how to respond. If
   * omitted under "ask", prompts are denied (cautious default).
   */
  onPermission?: (question: string, options: string[]) => Promise<'allow' | 'deny' | 'abort'>;
  /** Forwarded verbatim as extra CLI args (escape hatch). */
  extraArgs?: string[];

  // ---- dash-p-specific knobs (not in the real SDK) ----
  /** Path to the claude binary. */
  claudePath?: string;
  /** Terminal size for the emulated PTY. */
  terminalSize?: { cols: number; rows: number };
  /** Emit `stream_event` partial messages as text streams. */
  includePartialMessages?: boolean;
  /** Quiescence threshold in ms. */
  quietMs?: number;
  /** Rejoin TUI-hard-wrapped paragraphs into single lines (default true). */
  reflow?: boolean;
  debug?: boolean;
}

/** The query handle: an async iterator of messages plus live control methods. */
export interface Query extends AsyncGenerator<SDKMessage, void> {
  /** Stop the current turn. */
  interrupt(): Promise<void>;
  /** Change permission handling mid-session. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Best-effort; live model switching via the TUI is limited (see docs). */
  setModel(model?: string): Promise<void>;
}
