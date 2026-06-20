/**
 * Recognizer unit tests — run with `npm test` (tsx, no framework).
 *
 * Guards the regression where a newer TUI footer (persistent "0 tokens" counter,
 * no "? for shortcuts") made the recognizer report state=thinking forever while
 * an input box was clearly on screen.
 */
import { Recognizer } from '../src/recognize/recognizer.js';
import { selectProfile } from '../src/recognize/profile.js';
import type { EngineState, ScreenSnapshot } from '../src/types.js';

const profile = selectProfile('2.1.177').profile;
const recognizer = new Recognizer(profile);

function snap(lines: string[]): ScreenSnapshot {
  return {
    lines,
    wrapped: lines.map(() => false),
    viewport: lines,
    cursor: { x: 0, y: 0 },
    size: { cols: 100, rows: Math.max(lines.length, 24) },
    altScreen: false,
    seq: 1,
  };
}

const banner = [
  '╭─── Claude Code ─────────────────────────────────────────────────────────────────────────────────╮',
  '│                Welcome back ybouane!                                                              │',
  '│                       ▐▛███▜▌                                                                     │',
  '│  /Volumes/ExternalSSD/Projects/SideProjects/dash-p                                                │',
  '╰───────────────────────────────────────────────────────────────────────────────────────────────────╯',
  '',
];
const rule = '────────────────────────────────────────────────────────────────────────────────────────────────────';

// The reported 2.1.181 footer: persistent token counter, no "? for shortcuts".
const welcome_2_1_181 = snap([
  ...banner,
  rule,
  '❯ ',
  rule,
  '  bypass permissions · ← for agents                                                        0 tokens',
]);

// The real 2.1.177 idle footer.
const welcome_2_1_177 = snap([...banner, rule, '❯ ', rule, '  ? for shortcuts · ← for agents']);

// A live generation frame (interrupt hint + animated spinner + token count).
const generating = snap([
  ...banner,
  '❯ explain pseudo-terminals',
  '',
  '✻ Incubating… (2s · ↓ 51 tokens)',
  '',
  rule,
  '❯ ',
  rule,
  '  esc to interrupt                                                               ◉ xhigh · /effort',
]);

const cases: Array<{ name: string; snap: ScreenSnapshot; expect: EngineState | EngineState[] }> = [
  { name: '2.1.181 welcome (token footer, no shortcuts) → ready', snap: welcome_2_1_181, expect: 'ready' },
  { name: '2.1.177 welcome → ready', snap: welcome_2_1_177, expect: 'ready' },
  { name: 'generation frame (interrupt) → thinking/streaming', snap: generating, expect: ['thinking', 'streaming'] },
];

let failed = 0;
for (const c of cases) {
  const rec = recognizer.recognize(c.snap);
  const want = Array.isArray(c.expect) ? c.expect : [c.expect];
  const ok = want.includes(rec.state);
  if (!ok) failed++;
  console.log(
    `${ok ? '✓' : '✗'} ${c.name}  (got state=${rec.state} conf=${rec.confidence.toFixed(2)} matched=[${rec.matched.join(',')}])`,
  );
}

// Explicit assertion: a token counter alone must never read as busy.
const tokenOnly = recognizer.recognize(snap([rule, '❯ ', rule, '  0 tokens']));
const tokenOk = tokenOnly.state === 'ready';
if (!tokenOk) failed++;
console.log(`${tokenOk ? '✓' : '✗'} "0 tokens" footer alone is not busy  (got ${tokenOnly.state})`);

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall recognizer tests passed');
