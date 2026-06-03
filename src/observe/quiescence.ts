/**
 * Observation layer — decide when the screen has actually settled.
 *
 * The naive "output stopped changing" test fails because animations never stop:
 * spinners tick, gradients shimmer, the footer pulses. We instead hash only the
 * *content* and mask known-animated tokens (spinner glyphs, busy-footer text)
 * before comparing. An animation can run forever and the signature stays put.
 *
 * Long-output note: the emulator keeps a large scrollback, so the full answer
 * stays inside the snapshot's `lines` even after it scrolls past the viewport.
 * Incremental accumulation is only needed beyond that window.
 */
import type { ScreenSnapshot } from '../types.js';
import type { Profile } from '../recognize/profile.js';

/** Build a stable signature of the content, masking animated tokens. */
export function contentSignature(
  snap: ScreenSnapshot,
  profile: Profile,
  range: { start: number; end: number },
): string {
  const masked: string[] = [];
  for (let i = range.start; i < range.end; i++) {
    let line = snap.lines[i] ?? '';
    // Strip spinner frames and busy-footer text so motion is invisible.
    for (const g of profile.spinnerGlyphs) if (g) line = line.split(g).join('');
    for (const b of profile.busyMarkers) if (b) line = line.split(b).join('');
    const t = line.replace(/\s+$/, '');
    if (t.length) masked.push(t);
  }
  return djb2(masked.join('\n'));
}

export class QuiescenceTracker {
  private lastSig: string | null = null;
  private lastChange = now();

  /** Feed the latest signature; returns true if it represents a change. */
  update(sig: string): boolean {
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.lastChange = now();
      return true;
    }
    return false;
  }

  get msSinceChange(): number {
    return now() - this.lastChange;
  }

  isStable(quietMs: number): boolean {
    return this.msSinceChange >= quietMs;
  }

  reset(): void {
    this.lastSig = null;
    this.lastChange = now();
  }
}

function now(): number {
  return Date.now();
}

/** Cheap, allocation-light string hash. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
