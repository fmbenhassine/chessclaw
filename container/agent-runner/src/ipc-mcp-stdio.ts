/**
 * Stdio MCP Server for ChessClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const MEDIA_DIR = path.join(IPC_DIR, 'media');
const RESULTS_DIR = path.join(IPC_DIR, 'results');
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const HOST_ACTION_TIMEOUT_MS = 30000;
const HOST_ACTION_POLL_MS = 200;
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
]);

const chatJid = process.env.CHESSCLAW_CHAT_JID!;

function validateReadOnlySql(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error('SQL query is required.');
  }

  const withoutTrailingSemicolons = trimmed.replace(/;+$/, '').trim();
  if (withoutTrailingSemicolons.includes(';')) {
    throw new Error('Only a single SQL statement is allowed.');
  }

  const normalized = withoutTrailingSemicolons.toLowerCase();
  const allowedStarts = ['select', 'with', 'pragma', 'explain'];
  if (!allowedStarts.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error('Only read-only SELECT/WITH/PRAGMA/EXPLAIN queries are allowed.');
  }

  const forbidden = [
    'insert',
    'update',
    'delete',
    'replace',
    'drop',
    'alter',
    'attach',
    'detach',
    'create',
    'vacuum',
    'reindex',
    'truncate',
  ];
  if (forbidden.some((keyword) => normalized.includes(keyword))) {
    throw new Error('Only read-only SQL queries are allowed.');
  }

  return withoutTrailingSemicolons;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function resolveImagePath(inputPath: string): string {
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve('/workspace/assistant', inputPath);

  const allowedRoots = ['/workspace/assistant'];

  const isAllowed = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}/`),
  );
  if (!isAllowed) {
    throw new Error(
      `Image path must be inside one of: ${allowedRoots.join(', ')}`,
    );
  }

  return resolved;
}

function makeRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function waitForHostResult(
  requestId: string,
  timeoutMs = HOST_ACTION_TIMEOUT_MS,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const resultPath = path.join(RESULTS_DIR, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      try {
        const raw = fs.readFileSync(resultPath, 'utf-8');
        const parsed = JSON.parse(raw) as {
          ok?: boolean;
          result?: string;
          error?: string;
        };
        fs.unlinkSync(resultPath);
        return {
          ok: parsed.ok === true,
          result: parsed.result,
          error: parsed.error,
        };
      } catch (err) {
        try {
          fs.unlinkSync(resultPath);
        } catch {
          // ignore cleanup errors
        }
        throw new Error(
          `Failed to parse host response: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, HOST_ACTION_POLL_MS));
  }

  throw new Error(`Timed out waiting for host action response (${timeoutMs}ms)`);
}

async function requestHostAction(
  action: string,
  args: Record<string, unknown>,
  options?: { timeoutMs?: number },
): Promise<string> {
  const requestId = makeRequestId();
  const data = {
    type: 'macos_bridge_request',
    requestId,
    action,
    args,
    chatJid,
    timestamp: new Date().toISOString(),
  };

  writeIpcFile(TASKS_DIR, data);
  const response = await waitForHostResult(
    requestId,
    options?.timeoutMs ?? HOST_ACTION_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(response.error || 'Host action failed');
  }
  return response.result || '';
}

const server = new McpServer({
  name: 'chessclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent automatically — use this tool if you need to communicate with the user.",
  { text: z.string().describe('The message text to send') },
  async (args) => {
    const data = {
      type: 'message',
      chatJid,
      text: args.text,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_image',
  'Send an image file to the current chat. Use this to deliver screenshots or other images as actual Telegram media (not links).',
  {
    image_path: z.string().describe('Path to image file. Relative paths are resolved from /workspace/assistant.'),
    caption: z.string().optional().describe('Optional caption text.'),
  },
  async (args) => {
    let resolvedPath: string;
    try {
      resolvedPath = resolveImagePath(args.image_path);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }

    if (!fs.existsSync(resolvedPath)) {
      return {
        content: [{ type: 'text' as const, text: `Image not found: ${resolvedPath}` }],
        isError: true,
      };
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return {
        content: [{ type: 'text' as const, text: `Not a file: ${resolvedPath}` }],
        isError: true,
      };
    }

    const extension = path.extname(resolvedPath).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
      return {
        content: [{
          type: 'text' as const,
          text: `Unsupported image extension "${extension || '(none)'}". Allowed: ${Array.from(ALLOWED_IMAGE_EXTENSIONS).join(', ')}`,
        }],
        isError: true,
      };
    }

    if (stat.size > MAX_IMAGE_BYTES) {
      return {
        content: [{
          type: 'text' as const,
          text: `Image is too large (${stat.size} bytes). Max allowed is ${MAX_IMAGE_BYTES} bytes.`,
        }],
        isError: true,
      };
    }

    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const mediaFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
    const stagedPath = path.join(MEDIA_DIR, mediaFilename);
    fs.copyFileSync(resolvedPath, stagedPath);

    const data = {
      type: 'image_message',
      chatJid,
      mediaFilename,
      caption: args.caption?.trim() || undefined,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return {
      content: [{ type: 'text' as const, text: 'Image queued for delivery.' }],
    };
  },
);

server.tool(
  'query_chess_database',
  'Run a read-only SQL query against the ChessClaw SQLite database and return JSON rows. Use this for chess statistics, counts, openings, opponents, results, and other database-backed answers.',
  {
    sql: z.string().min(1).describe('A single read-only SQL statement. Prefer SELECT queries.'),
  },
  async (args) => {
    try {
      const sql = validateReadOnlySql(args.sql);
      const output = await requestHostAction('chess_db_query', { sql });

      return {
        content: [
          {
            type: 'text' as const,
            text: output.trim() || '[]',
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'fetch_chess_news',
  'Fetch recent chess news from a trusted host-backed source. Use this for latest chess news instead of web browsing from the container.',
  {
    source: z.enum(['fide']).default('fide').describe('News source to fetch from. Currently only official FIDE news is supported.'),
    limit: z.number().int().positive().max(10).optional().describe('Maximum number of items to return. Defaults to 5.'),
  },
  async (args) => {
    try {
      const output = await requestHostAction('chess_fetch_news', {
        source: args.source,
        limit: args.limit,
      }, { timeoutMs: 30000 });

      return {
        content: [{ type: 'text' as const, text: output.trim() || '[]' }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'sync_games',
  'Sync games for the configured user from Lichess or Chess.com through the host runtime, then ingest them into the ChessClaw database.',
  {
    platform: z.enum(['lichess', 'chesscom']).describe('Platform to sync from'),
  },
  async (args) => {
    try {
      const output = await requestHostAction('chess_sync_games', {
        platform: args.platform,
      }, { timeoutMs: 300000 });

      return {
        content: [
          {
            type: 'text' as const,
            text: output.trim() || 'Sync completed.',
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'download_games',
  'Download games for the configured user from Lichess or Chess.com on the host using the project script. This downloads files but does not ingest them by itself.',
  {
    platform: z.enum(['lichess', 'chesscom']).describe('Platform to download from'),
    mode: z.enum(['init', 'sync']).describe('Whether to download all games or only recent games'),
  },
  async (args) => {
    try {
      const output = await requestHostAction('chess_download_games', {
        platform: args.platform,
        mode: args.mode,
      }, { timeoutMs: 300000 });
      return {
        content: [{ type: 'text' as const, text: output.trim() || 'Download completed.' }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'ingest_games',
  'Ingest PGN files into the ChessClaw database on the host. Omit pgn_file to ingest all PGNs under data/games.',
  {
    pgn_file: z.string().optional().describe('Optional path under /workspace/assistant or project root to one PGN file'),
  },
  async (args) => {
    try {
      const output = await requestHostAction('chess_ingest_games', {
        pgn_file: args.pgn_file,
      }, { timeoutMs: 300000 });
      return {
        content: [{ type: 'text' as const, text: output.trim() || 'Ingest completed.' }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'analyze_games',
  'Analyze one game or all unanalyzed games for a player on the host and write missed-mate results into the database.',
  {
    player_name: z.string().min(1).describe('Player name to analyze'),
    game_id: z.number().int().positive().optional().describe('Optional game id to analyze'),
  },
  async (args) => {
    try {
      const output = await requestHostAction('chess_analyze_games', {
        player_name: args.player_name.trim(),
        game_id: args.game_id,
      }, { timeoutMs: 600000 });
      return {
        content: [{ type: 'text' as const, text: output.trim() || 'Analysis completed.' }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'render_puzzle_png',
  'Render one missed-mates row as a PNG on the host and place the output in the assistant workspace. Returns a container-visible image path suitable for send_image.',
  {
    missed_mate_id: z.number().int().positive().describe('Missed-mates row id to render'),
    output_path: z.string().optional().describe('Optional output path under /workspace/assistant'),
  },
  async (args) => {
    try {
      const output = await requestHostAction('chess_render_png', {
        missed_mate_id: args.missed_mate_id,
        output_path: args.output_path,
      }, { timeoutMs: 120000 });
      return {
        content: [{ type: 'text' as const, text: output.trim() }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'render_rating_plot',
  'Render a rating-evolution PNG on the host and place the output in the assistant workspace. Use this for Elo/rating charts instead of generating charts manually in the container.',
  {
    player_name: z.string().min(1).describe('Player name to chart'),
    platform: z.enum(['lichess', 'chesscom']).describe('Platform to chart'),
    days: z.number().int().positive().optional().describe('How many recent days to include. Defaults to 30.'),
    output_path: z.string().optional().describe('Optional output path under /workspace/assistant'),
  },
  async (args) => {
    try {
      const output = await requestHostAction('chess_render_rating_plot', {
        player_name: args.player_name.trim(),
        platform: args.platform,
        days: args.days,
        output_path: args.output_path,
      }, { timeoutMs: 120000 });
      return {
        content: [{ type: 'text' as const, text: output.trim() }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.
Tasks run in the same assistant workspace and conversation context as the chat.

MESSAGING BEHAVIOR - The task agent's output is sent to the user. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".` }],
          isError: true,
        };
      }
    }

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  'List all scheduled tasks.',
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
