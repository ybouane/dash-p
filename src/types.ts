/**
 * Shared domain types for the dash-p engine.
 *
 * These types are deliberately Claude-agnostic. Nothing in here knows what the
 * Claude TUI looks like — that knowledge lives entirely in the recognition layer
 * and its version profiles. Keeping the core ignorant of Claude is what lets a
 * future TUI redesign break only one layer.
 */

export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * A point-in-time view of the emulated screen, reconstructed from the virtual
 * terminal. `lines` is the full active buffer (scrollback + viewport) already
 * translated to plain strings with SGR/colour stripped — we parse *text and
 * structure*, never colour or motion.
 */
export interface ScreenSnapshot {
  /** Full active buffer, top-to-bottom, trailing whitespace trimmed. */
  lines: string[];
  /**
   * Per-line soft-wrap flags, parallel to `lines`. `wrapped[i] === true` means
   * line `i` is a continuation of line `i-1` (the emulator wrapped a long
   * logical line across rows). Used to rejoin paragraphs during extraction.
   */
  wrapped: boolean[];
  /** Just the visible viewport rows (what a human would see right now). */
  viewport: string[];
  /** Cursor position within the viewport (col x, row y). */
  cursor: { x: number; y: number };
  size: TerminalSize;
  /** True when the program switched to the alternate screen buffer. */
  altScreen: boolean;
  /** Monotonic counter of how many writes have been folded in. */
  seq: number;
}

/**
 * The controller's explicit state machine. Recognizers map a snapshot onto one
 * of these; the controller decides what is safe to do in each.
 */
export type EngineState =
  | 'launching'
  | 'ready' // input box visible, idle, safe to send
  | 'submitting' // we injected input, waiting for it to take
  | 'thinking' // busy, spinner up, no assistant tokens yet
  | 'streaming' // assistant tokens appearing
  | 'tool_permission' // a permission prompt is waiting for a decision
  | 'menu' // an arrow-key selection menu is open
  | 'complete' // turn finished, back to ready
  | 'error'
  | 'exited';

/**
 * A structured piece of the latest assistant turn, reconstructed from the TUI's
 * rendering: prose (`⏺ text`), a tool invocation (`⏺ Name(args)`), or a tool's
 * result (`⎿ output`). The SDK layer maps these onto Anthropic content blocks.
 */
export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; args: string }
  | { kind: 'tool_result'; text: string };

/** Output of the recognition layer for a single snapshot. */
export interface Recognition {
  state: EngineState;
  /** Indices into snapshot.lines that constitute conversation content (chrome excluded). */
  contentRange: { start: number; end: number } | null;
  /** The latest assistant turn's prose, best-effort extracted & unwrapped. */
  assistantText: string | null;
  /** The latest assistant turn parsed into ordered structured blocks. */
  blocks: TranscriptBlock[];
  /** Present when state === 'tool_permission'. */
  permission?: PermissionPrompt;
  /** Present when state === 'menu'. */
  menu?: MenuPrompt;
  /** 0..1 — how confident the recognizers are. Low values should trigger fallback. */
  confidence: number;
  /** Which recognizers fired, for debugging and drift detection. */
  matched: string[];
}

export interface PermissionPrompt {
  question: string;
  options: string[];
  /** Index of the option a given policy would pick, if decidable. */
  defaultIndex: number | null;
}

export interface MenuPrompt {
  title: string | null;
  options: string[];
  selectedIndex: number | null;
}

/** Events emitted by the engine as a turn progresses. */
export type EngineEvent =
  | { type: 'state'; state: EngineState; prev: EngineState }
  | { type: 'delta'; text: string } // newly-appended assistant text
  | { type: 'snapshot'; snapshot: ScreenSnapshot; recognition: Recognition }
  | { type: 'permission'; prompt: PermissionPrompt }
  | { type: 'menu'; prompt: MenuPrompt }
  | { type: 'turn-complete'; text: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn'; message: string }
  | { type: 'exit'; code: number | null; signal: number | null }
  | { type: 'error'; error: Error };

export interface PermissionDecision {
  /** 'allow' picks the affirmative option, 'deny' the negative, 'abort' interrupts. */
  action: 'allow' | 'deny' | 'abort';
}

/** How the engine should respond when the TUI asks to run a tool. */
export type PermissionPolicy =
  | 'ask' // bubble up to the caller (default, cautious)
  | 'allow' // always pick the affirmative option
  | 'deny'; // always pick the negative option
