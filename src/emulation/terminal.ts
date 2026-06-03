/**
 * Emulation layer — turns the child's raw byte stream into a virtual screen.
 *
 * We use @xterm/headless: the exact VT engine that powers VS Code's terminal,
 * running with no DOM. It maintains the cell grid, scrollback, wide-char width,
 * and — crucially — generates the correct *replies* to terminal device queries
 * (Device Attributes, cursor-position reports, etc.). We forward those replies
 * straight back up the PTY via `onReply`, which is what makes the child believe
 * it is talking to a genuine, capable terminal.
 */
import pkg from '@xterm/headless';
import type { Terminal as XTerm } from '@xterm/headless';
import type { ScreenSnapshot, TerminalSize } from '../types.js';

// @xterm/headless is CommonJS with no named ESM exports; interop the default.
const { Terminal } = pkg as unknown as { Terminal: typeof XTerm };

export interface TerminalEmulatorOptions {
  size: TerminalSize;
  /** Lines of scrollback to retain — large, so long answers are never lost. */
  scrollback?: number;
  /** Called with bytes the emulator wants to send back to the child. */
  onReply: (data: string) => void;
}

export class TerminalEmulator {
  private readonly term: XTerm;
  private seq = 0;

  constructor(opts: TerminalEmulatorOptions) {
    this.term = new Terminal({
      cols: opts.size.cols,
      rows: opts.size.rows,
      scrollback: opts.scrollback ?? 100_000,
      allowProposedApi: true,
      // We never render; keep it lean.
      convertEol: false,
    });

    // Device-query replies (DA1/DA2, DSR cursor reports, etc.) and any other
    // host-bound data the emulator produces get forwarded to the child. This is
    // the terminal-fidelity channel — answer queries like a real terminal does.
    this.term.onData((data: string) => opts.onReply(data));
  }

  /** Feed a chunk of child output into the emulator. Resolves once parsed. */
  write(data: string): Promise<void> {
    this.seq++;
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(size: TerminalSize): void {
    this.term.resize(size.cols, size.rows);
  }

  /** Reconstruct the current screen state as plain text + metadata. */
  snapshot(): ScreenSnapshot {
    const buf = this.term.buffer.active;
    const total = buf.length;
    const lines: string[] = new Array(total);
    const wrapped: boolean[] = new Array(total);
    for (let i = 0; i < total; i++) {
      const line = buf.getLine(i);
      lines[i] = line?.translateToString(true) ?? '';
      // isWrapped: this row is the continuation of the previous logical line.
      wrapped[i] = line?.isWrapped ?? false;
    }

    const rows = this.term.rows;
    const baseY = buf.baseY;
    const viewport: string[] = new Array(rows);
    for (let r = 0; r < rows; r++) viewport[r] = lines[baseY + r] ?? '';

    return {
      lines,
      wrapped,
      viewport,
      cursor: { x: buf.cursorX, y: buf.cursorY },
      size: { cols: this.term.cols, rows: this.term.rows },
      altScreen: buf.type === 'alternate',
      seq: this.seq,
    };
  }

  dispose(): void {
    this.term.dispose();
  }
}
