/**
 * node-pty ships its macOS/Linux `spawn-helper` inside prebuilds/, but npm can
 * extract it without the executable bit, causing `posix_spawnp failed` at spawn
 * time. Restore +x here so a fresh `npm install` just works.
 */
import { chmodSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';

const patterns = [
  'node_modules/node-pty/prebuilds/*/spawn-helper',
  'node_modules/node-pty/build/Release/spawn-helper',
];

let fixed = 0;
for (const pattern of patterns) {
  let matches = [];
  try {
    matches = globSync(pattern);
  } catch {
    // globSync unavailable on very old Node; ignore.
  }
  for (const p of matches) {
    if (existsSync(p)) {
      try {
        chmodSync(p, 0o755);
        fixed++;
      } catch {
        /* ignore */
      }
    }
  }
}
if (fixed) console.log(`[fix-node-pty] made ${fixed} spawn-helper(s) executable`);
