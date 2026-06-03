/**
 * Capture spike — drive the REAL Claude TUI through a PTY and dump what it
 * renders, so we can calibrate the recognition profile against ground truth.
 *
 *   npm run probe                 # default prompt
 *   npm run probe -- "your text"  # custom prompt
 *
 * Writes:
 *   fixtures/spike-frames.txt        distinct viewport frames over time
 *   fixtures/spike-final-buffer.txt  full scrollback at the end
 *   fixtures/spike-recognition.json  what the recognizer made of the final frame
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PtyTransport } from '../src/transport/pty.js';
import { TerminalEmulator } from '../src/emulation/terminal.js';
import { Recognizer } from '../src/recognize/recognizer.js';
import { loadProfile } from '../src/recognize/profile.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, '..', 'fixtures');

const prompt = process.argv[2] ?? 'Reply with exactly: hello from the tui';
const size = { cols: 100, rows: 30 };
const RUN_MS = Number(process.env.RUN_MS ?? 20_000);

const transport = new PtyTransport({
  file: process.env.CLAUDE_PATH ?? 'claude',
  args: [],
  size,
  unsetEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION', 'CLAUDE_CODE_SIMPLE'],
});
const emulator = new TerminalEmulator({ size, onReply: (d) => transport.write(d) });
const profile = loadProfile(process.env.VERSION ?? 'default');
const recognizer = new Recognizer(profile);

let chain: Promise<void> = Promise.resolve();
transport.on('data', (d: string) => {
  chain = chain.then(() => emulator.write(d)).catch(() => {});
});

const frames: string[] = [];
let lastFrame = '';
let sentPrompt = false;
let acceptedTrust = false;

function tick(): void {
  const snap = emulator.snapshot();
  const view = snap.viewport.join('\n').replace(/\s+$/g, '');
  if (view !== lastFrame) {
    lastFrame = view;
    const rec = recognizer.recognize(snap);
    frames.push(`--- t=${Date.now() % 100000} state=${rec.state} conf=${rec.confidence.toFixed(2)} matched=[${rec.matched.join(',')}] ---\n${snap.viewport.join('\n')}`);
  }

  const flat = snap.lines.join('\n');

  // Startup gate: accept the workspace trust dialog (the affirmative option is
  // already highlighted, so Enter selects "Yes, I trust this folder").
  if (!acceptedTrust && /trust this folder|Is this a project you/i.test(flat)) {
    acceptedTrust = true;
    log('trust dialog → Enter (accept default)');
    setTimeout(() => transport.write('\r'), 120);
    return;
  }

  // Once it looks idle/ready, send the prompt one time. (Trust acceptance is
  // best-effort above; if the folder is already trusted there's no dialog.)
  if (!sentPrompt) {
    const rec = recognizer.recognize(snap);
    if (rec.state === 'ready') {
      sentPrompt = true;
      log('detected ready → pasting prompt');
      transport.write('\x1b[200~' + prompt + '\x1b[201~');
      setTimeout(() => transport.write('\r'), 150);
    }
  }
}

function log(m: string): void {
  process.stderr.write(`[probe] ${m}\n`);
}

log(`spawning claude (${size.cols}x${size.rows}); capturing for ${RUN_MS}ms`);
transport.start();
const timer = setInterval(tick, 200);

transport.on('exit', (code: number | null) => log(`child exited code=${code}`));

setTimeout(async () => {
  clearInterval(timer);
  const snap = emulator.snapshot();
  const rec = recognizer.recognize(snap);

  writeFileSync(join(FIX, 'spike-frames.txt'), frames.join('\n\n'), 'utf8');
  writeFileSync(join(FIX, 'spike-final-buffer.txt'), snap.lines.join('\n'), 'utf8');
  writeFileSync(join(FIX, 'spike-recognition.json'), JSON.stringify(rec, null, 2), 'utf8');

  log(`captured ${frames.length} distinct frames`);
  log(`final state=${rec.state} confidence=${rec.confidence} assistantText=${JSON.stringify(rec.assistantText)}`);
  transport.write('\x03'); // Ctrl-C
  setTimeout(() => {
    transport.kill();
    process.exit(0);
  }, 300);
}, RUN_MS);
