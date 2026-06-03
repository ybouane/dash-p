/**
 * dash-p SDK example — the same shape as @anthropic-ai/claude-agent-sdk's
 * query(), but the answer comes from driving the interactive TUI.
 *
 *   npx tsx examples/sdk-basic.ts "your prompt here"
 */
import { query } from '../src/sdk/index.js';

const prompt = process.argv[2] ?? 'In one sentence, what is a pseudo-terminal?';

for await (const msg of query({
  prompt,
  options: {
    // model: 'sonnet',
    includePartialMessages: true,
    // Point at an explicit binary if `claude` isn't on node's PATH:
    claudePath: process.env.CLAUDE_PATH ?? 'claude',
  },
})) {
  switch (msg.type) {
    case 'system':
      console.error(`[init] claude ${msg.claude_code_version} · model ${msg.model}`);
      break;
    case 'stream_event':
      if (msg.event.type === 'content_block_delta')
        process.stdout.write(msg.event.delta.text);
      break;
    case 'assistant':
      // Final, clean assistant message (content blocks).
      break;
    case 'result':
      process.stdout.write('\n');
      console.error(
        `[result] ${msg.subtype} · ${msg.duration_ms}ms · confidence=${'confidence' in msg ? msg.confidence : 'n/a'}`,
      );
      break;
  }
}
