#!/usr/bin/env node
/**
 * dash-p CLI — mimics `claude -p`, but the answer is produced by driving the
 * real interactive TUI through a PTY (never the -p flag).
 *
 *   dash-p "explain this repo"
 *   dash-p -m sonnet --output-format json "summarise CHANGELOG"
 *   echo "long prompt" | dash-p
 */
import { Command } from 'commander';
import { query } from '../sdk/index.js';
import type { Options, PermissionMode, SDKMessage } from '../sdk/types.js';

interface CliOpts {
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  addDir?: string[];
  allowedTools?: string[];
  permissionMode?: PermissionMode;
  outputFormat: 'text' | 'json' | 'stream-json';
  cwd?: string;
  cols?: number;
  rows?: number;
  quietMs?: number;
  claudePath?: string;
  reflow?: boolean;
  verbose?: boolean;
  jsonSchema?: string;
  mcpConfig?: string[];
  betas?: string[];
  settings?: string;
  settingSources?: string;
  verifySession?: boolean;
  enrichFromSession?: boolean;
  debug?: boolean;
  dangerouslySkipPermissions?: boolean;
}

const program = new Command();

program
  .name('dash-p')
  .description('Claude -p, reverse-engineered through the interactive TUI')
  .argument('[prompt]', 'prompt to send (omit to read from stdin)')
  .option('-m, --model <model>', 'model alias or full name')
  .option('--system-prompt <text>', 'replace the system prompt')
  .option('--append-system-prompt <text>', 'append to the system prompt')
  .option('--add-dir <dirs...>', 'additional accessible directories')
  .option('--allowed-tools <tools...>', 'auto-allow these tools')
  .option('--permission-mode <mode>', 'default | acceptEdits | bypassPermissions | plan | dontAsk | auto')
  .option('-o, --output-format <fmt>', 'text | json | stream-json', 'text')
  .option('--cwd <dir>', 'working directory for the session')
  .option('--cols <n>', 'emulated terminal columns', (v) => parseInt(v, 10))
  .option('--rows <n>', 'emulated terminal rows', (v) => parseInt(v, 10))
  .option('--quiet-ms <n>', 'quiescence threshold in ms', (v) => parseInt(v, 10))
  .option('--claude-path <path>', 'path to the claude binary', 'claude')
  .option('--no-reflow', "keep the screen's literal line breaks (don't rejoin wrapped paragraphs)")
  .option('--no-verbose', "don't launch the TUI with --verbose (tool output may collapse)")
  .option('--json-schema <json>', 'JSON Schema for structured output (fills structured_output)')
  .option('--mcp-config <configs...>', 'MCP server JSON config files or strings')
  .option('--betas <betas...>', 'beta header names')
  .option('--settings <file-or-json>', 'settings file path or inline JSON')
  .option('--setting-sources <list>', 'comma-separated: user,project,local')
  .option('--verify-session', 'cross-check scraped output against the on-disk session JSONL')
  .option('--enrich-from-session', 'fill exact usage from the on-disk session JSONL (read-only)')
  .option('--dangerously-skip-permissions', 'run with --permission-mode bypassPermissions')
  .option('--debug', 'print engine logs to stderr')
  .action(async (promptArg: string | undefined, opts: CliOpts) => {
    const prompt = promptArg ?? (await readStdin());
    if (!prompt.trim()) {
      process.stderr.write('dash-p: no prompt provided (pass an argument or pipe via stdin)\n');
      process.exit(2);
    }

    const permissionMode: PermissionMode | undefined = opts.dangerouslySkipPermissions
      ? 'bypassPermissions'
      : opts.permissionMode;

    const sdkOptions: Options = {
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      additionalDirectories: opts.addDir,
      allowedTools: opts.allowedTools,
      permissionMode,
      cwd: opts.cwd,
      claudePath: opts.claudePath,
      terminalSize: opts.cols && opts.rows ? { cols: opts.cols, rows: opts.rows } : undefined,
      quietMs: opts.quietMs,
      reflow: opts.reflow,
      verbose: opts.verbose,
      mcpServers: opts.mcpConfig,
      betas: opts.betas,
      settings: opts.settings,
      settingSources: opts.settingSources,
      jsonSchema: opts.jsonSchema ? safeJson(opts.jsonSchema) : undefined,
      verifySession: opts.verifySession,
      enrichFromSession: opts.enrichFromSession,
      includePartialMessages: opts.outputFormat === 'stream-json',
      debug: opts.debug,
    };

    if (opts.debug) {
      // Surface engine logs without polluting stdout.
      process.env.DASH_P_DEBUG = '1';
    }

    const q = query({ prompt, options: sdkOptions });

    try {
      if (opts.outputFormat === 'stream-json') {
        for await (const msg of q) emitJsonLine(msg);
      } else {
        let final: Extract<SDKMessage, { type: 'result' }> | null = null;
        for await (const msg of q) {
          if (opts.debug && msg.type === 'user') process.stderr.write(`[user] ${JSON.stringify(msg.message.content)}\n`);
          if (msg.type === 'result') final = msg;
        }
        if (!final) {
          process.stderr.write('dash-p: no result produced\n');
          process.exit(1);
        }
        if (opts.outputFormat === 'json') {
          process.stdout.write(JSON.stringify(final, null, 2) + '\n');
        } else {
          const text = 'result' in final ? final.result ?? '' : '';
          process.stdout.write(text.endsWith('\n') ? text : text + '\n');
          if (final.type === 'result' && final.subtype === 'success' && final.degraded) {
            process.stderr.write('dash-p: ⚠ extraction degraded — output is a raw transcript fallback\n');
          }
        }
      }
    } catch (err) {
      process.stderr.write(`dash-p: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);

function emitJsonLine(msg: SDKMessage): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    process.stderr.write('dash-p: --json-schema is not valid JSON, ignoring\n');
    return undefined;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}
