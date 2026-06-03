/**
 * Action layer — inject input into the TUI.
 *
 * Writes are atomic and timing-free; the controller sequences them with the
 * delays the TUI needs (it owns the state machine). We never confirm input by
 * reading it back — large pastes get collapsed by the TUI — so callers confirm
 * via state transitions instead.
 */
import type { PtyTransport } from '../transport/pty.js';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, KEY } from './keys.js';

export class Actions {
  constructor(private readonly pty: PtyTransport) {}

  /** Type literal text (no trailing Enter). Small inputs only. */
  type(text: string): void {
    this.pty.write(text);
  }

  /**
   * Paste text atomically via bracketed paste. Chunked to avoid overflowing the
   * PTY input buffer on very large prompts.
   */
  paste(text: string): void {
    const CHUNK = 4096;
    this.pty.write(BRACKETED_PASTE_START);
    for (let i = 0; i < text.length; i += CHUNK) {
      this.pty.write(text.slice(i, i + CHUNK));
    }
    this.pty.write(BRACKETED_PASTE_END);
  }

  press(seq: string): void {
    this.pty.write(seq);
  }

  enter(): void {
    this.pty.write(KEY.ENTER);
  }

  /** Interrupt the current generation (best-effort: ESC, then Ctrl-C). */
  interrupt(): void {
    this.pty.write(KEY.ESC);
  }

  down(n = 1): void {
    for (let i = 0; i < n; i++) this.pty.write(KEY.DOWN);
  }

  up(n = 1): void {
    for (let i = 0; i < n; i++) this.pty.write(KEY.UP);
  }
}
