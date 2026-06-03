/**
 * Bucket 3 — read the session transcript Claude Code persists to disk.
 *
 * When dash-p launches the TUI with `--session-id <uuid>`, the interactive
 * session is written to `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. That
 * file is GROUND TRUTH: exact tool-input JSON, untruncated tool results, real
 * per-message usage, thinking — everything screen-scraping structurally can't
 * recover.
 *
 * This is used SPARSELY and is read-only: dash-p still *drives* only through the
 * TUI. The JSONL is an optional enrichment/verification oracle (default off), and
 * the recommended way to confirm the scraper is reading the screen correctly.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface SessionTurn {
  /** Final assistant prose (concatenated text blocks of the latest turn). */
  text: string;
  /** Ordered content blocks across the turn (text / tool_use / tool_result / thinking). */
  blocks: SessionBlock[];
  /** Summed usage across the turn's assistant messages. */
  usage: SessionUsage;
  model?: string;
}

export type SessionBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id?: string; content: unknown; is_error?: boolean };

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** Encode a cwd the way Claude Code names its project directory. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Locate the JSONL for a session id. Tries the cwd-derived path first, then
 * falls back to scanning every project dir (robust to any path encoding).
 */
export function findSessionFile(sessionId: string, cwd = process.cwd()): string | null {
  const direct = join(PROJECTS_DIR, encodeProjectDir(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  if (!existsSync(PROJECTS_DIR)) return null;
  for (const dir of safeReaddir(PROJECTS_DIR)) {
    const candidate = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Parse the JSONL into the message entries we care about. */
function readEntries(file: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip non-JSON / partial lines */
    }
  }
  return out;
}

/**
 * Extract the most recent turn (everything after the last human user message)
 * as exact structured blocks + summed usage. Returns null if the file has no
 * assistant content yet.
 */
export function readLatestTurn(file: string): SessionTurn | null {
  const entries = readEntries(file);
  // Find the last human user message (a prompt — not a tool_result carrier).
  let startIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isHumanUser(entries[i]!)) {
      startIdx = i;
      break;
    }
  }
  const slice = startIdx === -1 ? entries : entries.slice(startIdx + 1);

  const blocks: SessionBlock[] = [];
  const usage: SessionUsage = { input_tokens: 0, output_tokens: 0 };
  let model: string | undefined;

  for (const e of slice) {
    if (e.type !== 'assistant' && e.type !== 'user') continue;
    const msg = e.message as { content?: unknown; model?: string; usage?: Record<string, number> } | undefined;
    if (!msg) continue;
    if (typeof msg.model === 'string') model = msg.model;
    if (e.type === 'assistant' && msg.usage) {
      usage.input_tokens += msg.usage.input_tokens ?? 0;
      usage.output_tokens += msg.usage.output_tokens ?? 0;
      if (msg.usage.cache_read_input_tokens) usage.cache_read_input_tokens = (usage.cache_read_input_tokens ?? 0) + msg.usage.cache_read_input_tokens;
      if (msg.usage.cache_creation_input_tokens) usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens ?? 0) + msg.usage.cache_creation_input_tokens;
    }
    const content = msg.content;
    if (typeof content === 'string') {
      if (content) blocks.push({ type: 'text', text: content });
      continue;
    }
    if (Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) blocks.push(normalizeBlock(b));
    }
  }

  if (!blocks.length) return null;
  const text = blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();
  return { text, blocks, usage, model };
}

/** Compare scraped text to the session's ground-truth final text. */
export function compareScrapedToSession(
  scrapedText: string,
  file: string,
): { found: true; match: boolean; similarity: number; sessionText: string } | { found: false } {
  const turn = readLatestTurn(file);
  if (!turn) return { found: false };
  const a = normalize(scrapedText);
  const b = normalize(turn.text);
  const match = a === b;
  const similarity = match ? 1 : jaccard(a, b);
  return { found: true, match, similarity, sessionText: turn.text };
}

function isHumanUser(e: Record<string, unknown>): boolean {
  if (e.type !== 'user') return false;
  const content = (e.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    const arr = content as Array<{ type?: string }>;
    return arr.some((b) => b.type === 'text') && !arr.some((b) => b.type === 'tool_result');
  }
  return false;
}

function normalizeBlock(b: Record<string, unknown>): SessionBlock {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: String(b.text ?? '') };
    case 'thinking':
      return { type: 'thinking', thinking: String(b.thinking ?? '') };
    case 'tool_use':
      return { type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input: (b.input as Record<string, unknown>) ?? {} };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: b.tool_use_id as string | undefined, content: b.content, is_error: b.is_error as boolean | undefined };
    default:
      return { type: 'text', text: '' };
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function jaccard(a: string, b: string): number {
  const sa = new Set(a.split(' '));
  const sb = new Set(b.split(' '));
  if (!sa.size && !sb.size) return 1;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
