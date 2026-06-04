/**
 * node-pty ships its macOS/Linux `spawn-helper` inside prebuilds/, but npm can
 * extract it without the executable bit, causing `posix_spawnp failed` at spawn
 * time. Restore +x here so a fresh `npm install` just works — including when
 * dash-p is a dependency and node-pty is hoisted to a top-level node_modules.
 *
 * Resolves node-pty's real location (no hardcoded path, no fs.globSync — which
 * isn't available on Node 20) and never throws, so it can't break `npm install`.
 */
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

try {
  const require = createRequire(import.meta.url);
  const ptyDir = dirname(require.resolve('node-pty/package.json'));

  const candidates = [join(ptyDir, 'build', 'Release', 'spawn-helper')];
  const prebuilds = join(ptyDir, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const platform of readdirSync(prebuilds)) {
      candidates.push(join(prebuilds, platform, 'spawn-helper'));
    }
  }

  let fixed = 0;
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      chmodSync(p, 0o755);
      fixed++;
    } catch {
      /* read-only fs / Windows — ignore */
    }
  }
  if (fixed) console.log(`[fix-node-pty] made ${fixed} spawn-helper(s) executable`);
} catch {
  // node-pty not installed yet, or a platform with no spawn-helper (Windows).
  // Never fail the install over this.
}
