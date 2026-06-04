/**
 * Attribute-capture diagnostic — drive the TUI with a markdown-rich answer and
 * dump the screen WITH per-cell SGR styling (bold/italic/dim/underline/fg/bg),
 * which the normal snapshot strips. Lets us judge whether markdown constructs
 * (inline code, fenced blocks, bold, italic, headings, links) are cleanly
 * distinguishable by styling — i.e. whether reverse-rendering is feasible.
 *
 *   npm run probe:attrs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from '@xterm/headless';
import type { Terminal as XTerm } from '@xterm/headless';
import { PtyTransport } from '../src/transport/pty.js';

const { Terminal } = pkg as unknown as { Terminal: typeof XTerm };
const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, '..', 'fixtures');

const size = { cols: 100, rows: 40 };
const RUN_MS = Number(process.env.RUN_MS ?? 30_000);
const PROMPT =
  process.argv[2] ??
  'Reply with EXACTLY this markdown and nothing else:\n' +
    '## Heading Two\n' +
    'This has **bold words** and *italic words* and `inline code` in one line.\n' +
    '- first bullet\n' +
    '- second bullet\n\n' +
    '```python\n' +
    "print('hello world')\n" +
    '```\n' +
    'A link: [Anthropic](https://anthropic.com)\n' +
    '> a quoted line';

const transport = new PtyTransport({
  file: process.env.CLAUDE_PATH ?? 'claude',
  args: ['--verbose'],
  size,
  unsetEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION', 'CLAUDE_CODE_SIMPLE'],
});
const term = new Terminal({ cols: size.cols, rows: size.rows, scrollback: 50_000, allowProposedApi: true });
term.onData((d: string) => transport.write(d));

let chain: Promise<void> = Promise.resolve();
transport.on('data', (d: string) => {
  chain = chain.then(() => new Promise<void>((r) => term.write(d, r))).catch(() => {});
});

let acceptedTrust = false;
let sent = false;
function flat(): string {
  const buf = term.buffer.active;
  let s = '';
  for (let i = 0; i < buf.length; i++) s += (buf.getLine(i)?.translateToString(true) ?? '') + '\n';
  return s;
}

function tick(): void {
  const f = flat();
  if (!acceptedTrust && /trust this folder|Is this a project you/i.test(f)) {
    acceptedTrust = true;
    log('trust dialog → Enter');
    setTimeout(() => transport.write('\r'), 120);
    return;
  }
  if (!sent && /\? for shortcuts/.test(f)) {
    sent = true;
    log('ready → pasting markdown prompt');
    transport.write('\x1b[200~' + PROMPT + '\x1b[201~');
    setTimeout(() => transport.write('\r'), 200);
  }
}

function log(m: string): void {
  process.stderr.write(`[attrs] ${m}\n`);
}

/** Classify a cell into a single legend symbol (priority: code-bg > bold > italic > underline > dim > fg). */
function symbol(cell: any): string {
  if (cell.getChars() === '' || cell.getChars() === ' ') {
    return cell.isBgDefault() ? ' ' : '▒'; // styled blank (e.g. code-block padding)
  }
  if (!cell.isBgDefault()) return 'c';
  if (cell.isBold() && cell.isItalic()) return 'X';
  if (cell.isBold()) return 'B';
  if (cell.isItalic()) return 'I';
  if (cell.isUnderline()) return 'U';
  if (cell.isDim()) return 'd';
  if (!cell.isFgDefault()) return 'f';
  return '.';
}

function tupleKey(cell: any): string {
  return [
    cell.isBold() ? 'b' : '-',
    cell.isItalic() ? 'i' : '-',
    cell.isDim() ? 'd' : '-',
    cell.isUnderline() ? 'u' : '-',
    cell.isFgDefault() ? 'fgDef' : `fg${cell.getFgColorMode()}:${cell.getFgColor()}`,
    cell.isBgDefault() ? 'bgDef' : `bg${cell.getBgColorMode()}:${cell.getBgColor()}`,
  ].join(' ');
}

function dump(): void {
  const buf = term.buffer.active;
  const out: string[] = [];
  const legend = new Map<string, { count: number; sample: string }>();

  // Collect non-empty lines; keep the last 70 (the rendered answer sits near the bottom).
  const rows: number[] = [];
  for (let y = 0; y < buf.length; y++) {
    if ((buf.getLine(y)?.translateToString(true) ?? '').trim() !== '') rows.push(y);
  }
  for (const y of rows.slice(-70)) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    let styleRow = '';
    const cell = (line as any).getCell?.bind(line);
    for (let x = 0; x < size.cols; x++) {
      const c = line.getCell(x);
      if (!c) {
        styleRow += ' ';
        continue;
      }
      styleRow += symbol(c);
      const ch = c.getChars();
      if (ch && ch !== ' ') {
        const key = tupleKey(c);
        const e = legend.get(key);
        if (e) e.count++;
        else legend.set(key, { count: 1, sample: text.trim().slice(0, 40) });
      }
      void cell;
    }
    out.push('TXT ' + text);
    out.push('STY ' + styleRow.replace(/\s+$/, ''));
  }

  const legendLines = [...legend.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([k, v]) => `${String(v.count).padStart(5)}  ${k}   e.g. "${v.sample}"`);

  const report =
    '=== STYLE LEGEND (symbol priority: c=code-bg B=bold I=italic X=bold+italic U=underline d=dim f=fg-color .=plain ▒=styled-blank) ===\n' +
    '=== distinct style tuples (count, attrs, sample) ===\n' +
    legendLines.join('\n') +
    '\n\n=== lines (TXT = text, STY = per-cell style) ===\n' +
    out.join('\n');
  writeFileSync(join(FIX, 'attrs-report.txt'), report, 'utf8');
  log(`wrote fixtures/attrs-report.txt (${rows.length} non-empty lines, ${legend.size} distinct style tuples)`);
}

log(`spawning claude --verbose (${size.cols}x${size.rows}) for ${RUN_MS}ms`);
transport.start();
const timer = setInterval(tick, 200);
setTimeout(() => {
  clearInterval(timer);
  dump();
  transport.write('\x03');
  setTimeout(() => {
    transport.kill();
    process.exit(0);
  }, 300);
}, RUN_MS);
