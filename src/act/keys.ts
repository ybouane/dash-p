/** Raw key/escape sequences for input injection. */
export const KEY = {
  ENTER: '\r',
  ESC: '\x1b',
  CTRL_C: '\x03',
  CTRL_D: '\x04',
  TAB: '\t',
  BACKSPACE: '\x7f',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
} as const;

/**
 * Bracketed paste wrappers. Sending large/multi-line input between these tells
 * the TUI "this is a paste, not keystrokes" — it won't fire autocomplete or
 * slash-command popups per character, and won't echo it back verbatim (it may
 * collapse into a "[Pasted text +N lines]" placeholder).
 */
export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';
