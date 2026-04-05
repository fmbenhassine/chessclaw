import { exec, execFile, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_DIR,
  ASSISTANT_CHAT_ID,
  CHESSCLAW_CHESSCOM_USERNAME,
  CHESSCLAW_LICHESS_USERNAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  IPC_POLL_INTERVAL,
  POLL_INTERVAL,
  TELEGRAM_BOT_TOKEN,
  TIMEZONE,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAssistantConfig,
  createTask,
  deleteTask,
  getAllTasks,
  getSession,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTaskById,
  initDatabase,
  setAssistantConfig,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessageDirect,
  updateTask,
} from './db.js';
import {
  connectTelegram,
  sendTelegramImage,
  sendTelegramMessage,
  setTelegramTyping,
  stopTelegram,
  TelegramIncomingMessage,
} from './telegram.js';
import { MessageQueue } from './message-queue.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { AssistantConfig, NewMessage } from './types.js';
import { logger } from './logger.js';

let lastTimestamp = '';
let assistantConfig: AssistantConfig | undefined;
let sessionId = '';
let lastAgentTimestamp = '';
let messageLoopRunning = false;
let ipcWatcherRunning = false;
const execFileAsync = promisify(execFile);

const queue = new MessageQueue();

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  try {
    await setTelegramTyping(jid, isTyping);
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to update typing status');
  }
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  lastAgentTimestamp = getRouterState('last_agent_timestamp') || '';
  sessionId = getSession() || '';
  assistantConfig = getAssistantConfig();
  if (assistantConfig && !assistantConfig.chat_jid.startsWith('tg:')) {
    logger.warn(
      { chatJid: assistantConfig.chat_jid },
      'Ignoring stale non-Telegram assistant chat configuration from previous runtime',
    );
    assistantConfig = undefined;
  }
  logger.info({ chatJid: assistantConfig?.chat_jid || null }, 'State loaded');
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', lastAgentTimestamp);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) =>
    `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

/**
 * Process all pending messages for the configured assistant chat.
 * Uses streaming output so follow-up messages can be piped into the active
 * container without spawning a new one immediately.
 */
async function processChannelMessages(chatJid: string): Promise<boolean> {
  if (!assistantConfig || chatJid !== assistantConfig.chat_jid) return true;

  const missedMessages = getMessagesSince(chatJid, lastAgentTimestamp);

  if (missedMessages.length === 0) return true;

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp;
  lastAgentTimestamp = missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info({ chatJid, messageCount: missedMessages.length }, 'Processing messages');

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ chatJid }, 'Idle timeout, closing container stdin');
      queue.closeStdin();
    }, IDLE_TIMEOUT);
  };

  await setTyping(chatJid, true);
  let hadError = false;
  let sentAnyOutput = false;

  const output = await runAgent(prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ chatJid }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await sendMessage(chatJid, text);
        sentAnyOutput = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    if (!sentAnyOutput) {
      // Roll back cursor so retries can re-process these messages
      lastAgentTimestamp = previousCursor;
      saveState();
      logger.warn({ chatJid }, 'Agent error before any output, rolled back message cursor for retry');
      return false;
    }

    // We already sent output for this batch. Keep cursor advanced so
    // timeout/error retries do not re-send duplicate replies.
    logger.warn({ chatJid }, 'Agent error after output delivery, keeping cursor to avoid duplicate resend');
    return true;
  }

  return true;
}

async function runAgent(
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const tasks = getAllTasks();
  writeTasksSnapshot(
    tasks.map((t) => ({
      id: t.id,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessionId = output.newSessionId;
          setSession(output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      {
        prompt,
        sessionId,
        chatJid,
        containerTimeout: assistantConfig?.containerTimeout,
      },
      (proc, containerName) => queue.registerProcess(proc, containerName),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessionId = output.newSessionId;
      setSession(output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error({ chatJid, error: output.error }, 'Container agent error');
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ chatJid, err }, 'Agent error');
    return 'error';
  }
}

async function sendMessage(jid: string, text: string): Promise<void> {
  await sendTelegramMessage(jid, text);
  logger.info({ jid, length: text.length }, 'Message sent');
}

async function sendImageMessage(
  jid: string,
  imagePath: string,
  caption?: string,
  cleanupPath?: string,
): Promise<void> {
  try {
    await sendTelegramImage(jid, imagePath, caption);
    logger.info(
      {
        jid,
        imagePath,
        captionLength: caption?.length || 0,
      },
      'Image sent',
    );
  } finally {
    if (cleanupPath) {
      try {
        fs.unlinkSync(cleanupPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampLimit(value: unknown, fallback: number, max = 50): number {
  return clampInt(value, fallback, 1, max);
}

function clampDays(value: unknown, fallback: number): number {
  return clampInt(value, fallback, 1, 365);
}

function asString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function parseEmailList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/[,;\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toAppleScriptStringLiteral(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n').map((part) => `"${escapeAppleScriptString(part)}"`);
  if (parts.length === 0) return '""';
  if (parts.length === 1) return parts[0];
  return parts.join(' & linefeed & ');
}

async function runAppleScript(script: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 2,
    });
    return (stdout || '').trim();
  } catch (err) {
    const baseMsg = err instanceof Error ? err.message : String(err);
    const stderr =
      typeof err === 'object' &&
      err &&
      'stderr' in err &&
      typeof (err as { stderr?: unknown }).stderr === 'string'
        ? ((err as { stderr: string }).stderr || '').trim()
        : '';
    const suffix = stderr ? ` | stderr: ${stderr}` : '';
    throw new Error(`AppleScript execution failed: ${baseMsg}${suffix}`);
  }
}

function buildAppleScriptLines(lines: string[]): string {
  return lines.join('\n');
}

function getMailEnvelopeIndexPath(): string | null {
  const homeDir = process.env.HOME;
  if (!homeDir) return null;

  const mailRoot = path.join(homeDir, 'Library', 'Mail');
  if (!fs.existsSync(mailRoot)) return null;

  const versions = fs
    .readdirSync(mailRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^V\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number.parseInt(b.slice(1), 10) - Number.parseInt(a.slice(1), 10));

  for (const version of versions) {
    const envelopeIndex = path.join(mailRoot, version, 'MailData', 'Envelope Index');
    if (fs.existsSync(envelopeIndex)) {
      return envelopeIndex;
    }
  }

  return null;
}

function asFallbackText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function getChessDatabasePath(): string {
  return path.join(DATA_DIR, 'db.sqlite');
}

function getProjectRoot(): string {
  return process.cwd();
}

function getAssistantRendersDirectory(): string {
  const rendersDir = path.join(ASSISTANT_DIR, 'renders');
  fs.mkdirSync(rendersDir, { recursive: true });
  return rendersDir;
}

function isUnderRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveAgentPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    throw new Error('Path is required.');
  }

  if (trimmed.startsWith('/workspace/assistant/')) {
    const rel = path.posix.relative('/workspace/assistant', trimmed);
    return path.resolve(ASSISTANT_DIR, rel);
  }

  const assistantResolved = path.resolve(ASSISTANT_DIR, trimmed);
  if (isUnderRoot(assistantResolved, ASSISTANT_DIR)) {
    return assistantResolved;
  }

  const projectResolved = path.resolve(getProjectRoot(), trimmed);
  if (isUnderRoot(projectResolved, getProjectRoot())) {
    return projectResolved;
  }

  throw new Error('Path must be under the assistant workspace or project root.');
}

async function runChessScript(
  scriptName: string,
  args: string[],
  options?: {
    timeoutMs?: number;
  },
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 300000;
  const allowedUsernames = [
    CHESSCLAW_LICHESS_USERNAME.trim(),
    CHESSCLAW_CHESSCOM_USERNAME.trim(),
  ].filter((value, index, array) => value && array.indexOf(value) === index);
  const { stdout, stderr } = await execFileAsync(
    'uv',
    ['run', 'python', `backend/${scriptName}`, ...args],
    {
      cwd: getProjectRoot(),
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 20,
      env: {
        ...process.env,
        CHESSCLAW_DATABASE_PATH: getChessDatabasePath(),
        CHESSCLAW_ALLOWED_USERNAMES: allowedUsernames.join(','),
      },
    },
  );

  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

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

function getConfiguredPlatformUsername(platform: 'lichess' | 'chesscom'): string {
  const username =
    platform === 'lichess'
      ? CHESSCLAW_LICHESS_USERNAME.trim()
      : CHESSCLAW_CHESSCOM_USERNAME.trim();

  if (!username) {
    const envName =
      platform === 'lichess'
        ? 'CHESSCLAW_LICHESS_USERNAME'
        : 'CHESSCLAW_CHESSCOM_USERNAME';
    throw new Error(`No configured ${platform} username. Set ${envName} during setup.`);
  }

  return username;
}

function isFsPermissionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES';
}

async function listUnreadMailFromEnvelopeIndex(limit: number): Promise<string> {
  const envelopeIndex = getMailEnvelopeIndexPath();
  if (!envelopeIndex) {
    throw new Error('Mail Envelope Index not found');
  }

  const sql = [
    "SELECT COALESCE(s.subject, ''), COALESCE(a.address, '')",
    'FROM messages m',
    'JOIN mailboxes mb ON mb.ROWID = m.mailbox',
    'LEFT JOIN subjects s ON s.ROWID = m.subject',
    'LEFT JOIN addresses a ON a.ROWID = m.sender',
    'WHERE m.read = 0',
    '  AND m.deleted = 0',
    "  AND (mb.url LIKE '%/INBOX' OR mb.url LIKE '%/Inbox')",
    'ORDER BY COALESCE(m.display_date, m.date_received) DESC',
    `LIMIT ${limit};`,
  ].join('\n');

  const { stdout } = await execFileAsync('sqlite3', ['-tabs', envelopeIndex, sql], {
    timeout: 15000,
    maxBuffer: 1024 * 1024 * 2,
  });

  const rows = (stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rows.length === 0) {
    return '';
  }

  return rows
    .map((row) => {
      const [subjectRaw = '', senderRaw = ''] = row.split('\t');
      const subject = asFallbackText(subjectRaw, '(no subject)');
      const sender = asFallbackText(senderRaw, '(unknown sender)');
      return `${subject} || ${sender}`;
    })
    .join('\n');
}

function buildMailComposeScript(args: {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  fromAddress: string;
  sendNow: boolean;
}): string {
  const lines: string[] = [
    'with timeout of 30 seconds',
    '  tell application "Mail"',
    `    set requestedFrom to "${escapeAppleScriptString(args.fromAddress)}"`,
    '    if requestedFrom is not "" then',
    '      repeat with acc in every account',
      '        try',
        '          set accEmails to email addresses of acc',
        '          if accEmails contains requestedFrom then',
            '            exit repeat',
          '          end if',
        '        end try',
      '      end repeat',
      '      set hasMatchingAccount to false',
      '      repeat with acc in every account',
      '        try',
      '          set accEmails to email addresses of acc',
      '          if accEmails contains requestedFrom then',
      '            set hasMatchingAccount to true',
      '            exit repeat',
      '          end if',
      '        end try',
      '      end repeat',
      '      if hasMatchingAccount is false then',
        '        error "Configured Mail account not found for: " & requestedFrom',
      '      end if',
    '    end if',
    `    set msg to make new outgoing message with properties {subject:${toAppleScriptStringLiteral(args.subject)}, content:${toAppleScriptStringLiteral(args.body)}}`,
    '    tell msg',
      '      if requestedFrom is not "" then',
        '        try',
          '          set sender to requestedFrom',
        '        end try',
      '      end if',
  ];

  for (const address of args.to) {
    lines.push(
      `      make new to recipient at end of to recipients with properties {address:"${escapeAppleScriptString(address)}"}`,
    );
  }

  for (const address of args.cc) {
    lines.push(
      `      make new cc recipient at end of cc recipients with properties {address:"${escapeAppleScriptString(address)}"}`,
    );
  }

  for (const address of args.bcc) {
    lines.push(
      `      make new bcc recipient at end of bcc recipients with properties {address:"${escapeAppleScriptString(address)}"}`,
    );
  }

  lines.push('    end tell');

  if (args.sendNow) {
    lines.push('    send msg');
    lines.push('    return "Email sent."');
  } else {
    lines.push('    save msg');
    lines.push('    return "Draft created."');
  }

  lines.push('  end tell');
  lines.push('end timeout');

  return buildAppleScriptLines(lines);
}

const CONTAINER_ASSISTANT_ROOT = '/workspace/assistant';

function toContainerProjectPath(hostPath: string): string {
  const rel = path.relative(ASSISTANT_DIR, hostPath);
  if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is not under assistant workspace: ${hostPath}`);
  }
  return path.join(CONTAINER_ASSISTANT_ROOT, rel);
}

function getPeekabooOutputRoot(): string {
  const root = path.join(ASSISTANT_DIR, 'peekaboo');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function makeTimestampedFilename(prefix: string, ext: string): string {
  const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${normalizedExt}`;
}

function resolvePeekabooOutputPath(
  requestedPath: unknown,
  fallbackFilename: string,
): string {
  const root = getPeekabooOutputRoot();
  if (typeof requestedPath !== 'string') {
    return path.join(root, fallbackFilename);
  }
  const trimmed = requestedPath.trim();
  if (!trimmed) {
    return path.join(root, fallbackFilename);
  }
  const resolved = path.resolve(root, trimmed);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`peekaboo output path must be under: ${root}`);
  }
  return resolved;
}

function getPeekabooEnv(): NodeJS.ProcessEnv {
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin'];
  const existingPath = process.env.PATH || '';
  return {
    ...process.env,
    PATH: [...extraPaths, existingPath].filter(Boolean).join(':'),
  };
}

async function runPeekabooCli(
  args: string[],
  timeoutMs = 60000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('peekaboo', args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 10,
      env: getPeekabooEnv(),
    });
    return {
      stdout: (stdout || '').trim(),
      stderr: (stderr || '').trim(),
    };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === 'ENOENT') {
      throw new Error(
        'Peekaboo is not installed on the macOS host. Install with:\n\nbrew install steipete/tap/peekaboo',
      );
    }

    const baseMsg = err instanceof Error ? err.message : String(err);
    const stderr =
      typeof err === 'object' &&
      err &&
      'stderr' in err &&
      typeof (err as { stderr?: unknown }).stderr === 'string'
        ? ((err as { stderr: string }).stderr || '').trim()
        : '';
    const suffix = stderr ? ` | stderr: ${stderr}` : '';
    throw new Error(`Peekaboo command failed: ${baseMsg}${suffix}`);
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripXmlTags(text: string): string {
  return decodeXmlEntities(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractXmlTag(block: string, tagName: string): string {
  const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'));
  return match ? stripXmlTags(match[1]) : '';
}

async function fetchFideNews(limit: number): Promise<string> {
  const response = await fetch('https://www.fide.com/feed/', {
    signal: AbortSignal.timeout(15000),
    headers: {
      'user-agent': 'ChessClaw/1.0 (+https://github.com/fmbenhassine/chessclaw)',
      accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
    },
  });

  if (!response.ok) {
    throw new Error(`FIDE feed request failed with status ${response.status}`);
  }

  const xml = await response.text();
  const itemMatches = Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi))
    .slice(0, limit)
    .map((match) => match[0]);

  const items = itemMatches.map((itemBlock) => ({
    title: extractXmlTag(itemBlock, 'title'),
    link: extractXmlTag(itemBlock, 'link'),
    published_at: extractXmlTag(itemBlock, 'pubDate'),
    guid: extractXmlTag(itemBlock, 'guid'),
  })).filter((item) => item.title && item.link);

  return JSON.stringify(items, null, 2);
}

async function handleMacosBridgeAction(
  action: string,
  args: Record<string, unknown> | undefined,
): Promise<string> {
  const input = args || {};

  switch (action) {
    case 'chess_db_query': {
      const sql = validateReadOnlySql(asString(input.sql));
      const { stdout } = await execFileAsync(
        'sqlite3',
        ['-json', getChessDatabasePath(), sql],
        {
          timeout: 15000,
          maxBuffer: 1024 * 1024 * 10,
        },
      );
      return (stdout || '').trim() || '[]';
    }

    case 'chess_fetch_news': {
      const source = asString(input.source) || 'fide';
      const limitRaw = input.limit;
      const limit =
        limitRaw === undefined || limitRaw === null || `${limitRaw}`.trim() === ''
          ? 5
          : Number(limitRaw);
      if (!Number.isInteger(limit) || limit <= 0 || limit > 10) {
        throw new Error('chess_fetch_news requires integer "limit" between 1 and 10');
      }

      if (source !== 'fide') {
        throw new Error('chess_fetch_news currently supports source "fide" only');
      }

      return await fetchFideNews(limit);
    }

    case 'chess_sync_games': {
      const platform = asString(input.platform);
      if (platform !== 'lichess' && platform !== 'chesscom') {
        throw new Error('chess_sync_games requires platform "lichess" or "chesscom"');
      }
      const username = getConfiguredPlatformUsername(platform);

      const combined = await runChessScript(
        'sync-games.py',
        [username, '--platform', platform],
        { timeoutMs: 300000 },
      );
      return combined || `Synced ${platform} games for ${username}.`;
    }

    case 'chess_download_games': {
      const platform = asString(input.platform);
      const mode = asString(input.mode);
      if (platform !== 'lichess' && platform !== 'chesscom') {
        throw new Error('chess_download_games requires platform "lichess" or "chesscom"');
      }
      if (mode !== 'init' && mode !== 'sync') {
        throw new Error('chess_download_games requires mode "init" or "sync"');
      }
      const username = getConfiguredPlatformUsername(platform);

      const output = await runChessScript(
        'download-games.py',
        [username, '--platform', platform, '--mode', mode],
        { timeoutMs: 300000 },
      );
      return output || `Downloaded ${platform} games for ${username}.`;
    }

    case 'chess_ingest_games': {
      const pgnFile = asString(input.pgn_file);
      const args = pgnFile ? [resolveAgentPath(pgnFile)] : [];
      const output = await runChessScript('ingest-games.py', args, {
        timeoutMs: 300000,
      });
      return output || 'Game ingestion completed.';
    }

    case 'chess_analyze_games': {
      const playerName = asString(input.player_name);
      if (!playerName) throw new Error('chess_analyze_games requires "player_name"');
      const gameIdRaw = input.game_id;
      const args = [playerName];
      if (gameIdRaw !== undefined && gameIdRaw !== null && `${gameIdRaw}`.trim() !== '') {
        args.push(String(Number(gameIdRaw)));
      }
      const output = await runChessScript('find-missed-mates.py', args, {
        timeoutMs: 600000,
      });
      return output || 'Game analysis completed.';
    }

    case 'chess_render_png': {
      const missedMateId = Number(input.missed_mate_id);
      if (!Number.isInteger(missedMateId) || missedMateId <= 0) {
        throw new Error('chess_render_png requires a positive integer "missed_mate_id"');
      }

      const outputPathInput = asString(input.output_path);
      const hostOutputPath = outputPathInput
        ? resolveAgentPath(outputPathInput)
        : path.join(getAssistantRendersDirectory(), `missed-mate-${missedMateId}.png`);
      fs.mkdirSync(path.dirname(hostOutputPath), { recursive: true });

      await runChessScript(
        'render-png.py',
        [String(missedMateId), hostOutputPath],
        { timeoutMs: 120000 },
      );

      return toContainerProjectPath(hostOutputPath);
    }

    case 'chess_render_rating_plot': {
      const playerName = asString(input.player_name);
      if (!playerName) {
        throw new Error('chess_render_rating_plot requires "player_name"');
      }
      const platform = asString(input.platform);
      if (platform !== 'lichess' && platform !== 'chesscom') {
        throw new Error('chess_render_rating_plot requires platform "lichess" or "chesscom"');
      }

      const daysRaw = input.days;
      const days =
        daysRaw === undefined || daysRaw === null || `${daysRaw}`.trim() === ''
          ? 30
          : Number(daysRaw);
      if (!Number.isInteger(days) || days <= 0) {
        throw new Error('chess_render_rating_plot requires a positive integer "days"');
      }

      const outputPathInput = asString(input.output_path);
      const slug = playerName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'player';
      const hostOutputPath = outputPathInput
        ? resolveAgentPath(outputPathInput)
        : path.join(getAssistantRendersDirectory(), `rating-evolution-${slug}.png`);
      fs.mkdirSync(path.dirname(hostOutputPath), { recursive: true });

      await runChessScript(
        'render-rating-plot.py',
        [playerName, '--platform', platform, hostOutputPath, '--days', String(days)],
        { timeoutMs: 120000 },
      );

      return toContainerProjectPath(hostOutputPath);
    }

    default:
      throw new Error(`Unsupported macOS bridge action: ${action}`);
  }
}

function writeMacosBridgeResponse(
  requestId: string,
  payload: { ok: boolean; result?: string; error?: string },
): void {
  const resultsDir = path.join(DATA_DIR, 'ipc', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const filepath = path.join(resultsDir, `${requestId}.json`);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, filepath);
}

function startIpcWatcher(): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    const messagesDir = path.join(ipcBaseDir, 'messages');
    const tasksDir = path.join(ipcBaseDir, 'tasks');
    const mediaDir = path.join(ipcBaseDir, 'media');
    const errorDir = path.join(ipcBaseDir, 'errors');

    try {
      if (fs.existsSync(messagesDir)) {
        const messageFiles = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
        for (const file of messageFiles) {
          const filePath = path.join(messagesDir, file);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
              type?: string;
              chatJid?: string;
              text?: string;
              mediaFilename?: string;
              caption?: string;
            };

            const configuredChatJid = assistantConfig?.chat_jid;
            if (data.chatJid && configuredChatJid && data.chatJid !== configuredChatJid) {
              logger.warn({ chatJid: data.chatJid }, 'Ignoring IPC message for non-configured chat');
            } else if (data.type === 'message' && data.chatJid && data.text) {
              await sendMessage(data.chatJid, data.text);
            } else if (
              data.type === 'image_message' &&
              data.chatJid &&
              data.mediaFilename
            ) {
              const mediaPath = path.join(mediaDir, data.mediaFilename);
              const caption = data.caption || undefined;
              await sendImageMessage(data.chatJid, mediaPath, caption, mediaPath);
            }

            fs.unlinkSync(filePath);
          } catch (err) {
            logger.error({ file, err }, 'Error processing IPC message');
            fs.mkdirSync(errorDir, { recursive: true });
            fs.renameSync(filePath, path.join(errorDir, file));
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error reading IPC messages directory');
    }

    try {
      if (fs.existsSync(tasksDir)) {
        const taskFiles = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
        for (const file of taskFiles) {
          const filePath = path.join(tasksDir, file);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            await processTaskIpc(data);
            fs.unlinkSync(filePath);
          } catch (err) {
            logger.error({ file, err }, 'Error processing IPC task');
            fs.mkdirSync(errorDir, { recursive: true });
            fs.renameSync(filePath, path.join(errorDir, file));
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error reading IPC tasks directory');
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    chatJid?: string;
    requestId?: string;
    action?: string;
    args?: Record<string, unknown>;
  },
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value) {
        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        createTask({
          id: taskId,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info({ taskId }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId }, 'Task pause requested for unknown task');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId }, 'Task resume requested for unknown task');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId }, 'Task cancellation requested for unknown task');
        }
      }
      break;

    case 'macos_bridge_request':
      if (!data.requestId || !data.action) {
        logger.warn({ data }, 'Invalid macos_bridge_request - missing requestId/action');
        break;
      }
      try {
        const result = await handleMacosBridgeAction(data.action, data.args);
        writeMacosBridgeResponse(data.requestId, {
          ok: true,
          result,
        });
        logger.info({ requestId: data.requestId, action: data.action }, 'macOS bridge action completed');
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        writeMacosBridgeResponse(data.requestId, {
          ok: false,
          error,
        });
        logger.warn({ requestId: data.requestId, action: data.action, error }, 'macOS bridge action failed');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

function ensureAssistantConfig(): void {
  if (!ASSISTANT_CHAT_ID) return;

  if (assistantConfig?.chat_jid === ASSISTANT_CHAT_ID) return;

  assistantConfig = {
    chat_jid: ASSISTANT_CHAT_ID,
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  };
  setAssistantConfig(assistantConfig);
  logger.info({ chatJid: ASSISTANT_CHAT_ID }, 'Assistant channel initialized');
}

async function handleTelegramMessage(message: TelegramIncomingMessage): Promise<void> {
  storeChatMetadata(message.chatJid, message.timestamp, message.chatName);

  const configuredChatJid = assistantConfig?.chat_jid || ASSISTANT_CHAT_ID;
  if (!configuredChatJid || message.chatJid !== configuredChatJid) {
    return;
  }

  if (!assistantConfig) {
    assistantConfig = {
      chat_jid: message.chatJid,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    setAssistantConfig(assistantConfig);
  }

  storeMessageDirect({
    id: message.id,
    chatJid: message.chatJid,
    sender: message.sender,
    senderName: message.senderName,
    content: message.content,
    timestamp: message.timestamp,
    isFromMe: message.isFromMe,
  });
}

async function startTelegramRuntime(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is required. Run /setup to configure Telegram.');
  }

  ensureAssistantConfig();

  await connectTelegram({
    botToken: TELEGRAM_BOT_TOKEN,
    onMessage: handleTelegramMessage,
  });

  if (!assistantConfig) {
    logger.warn(
      'Assistant channel is not configured yet. Use /chatid in Telegram and set ASSISTANT_CHAT_ID.',
    );
  }

  startSchedulerLoop({
    assistant: () => assistantConfig,
    queue,
    onProcess: (proc, containerName) =>
      queue.registerProcess(proc, containerName),
    sendMessage,
  });
  startIpcWatcher();
  queue.setProcessMessagesFn(() => processChannelMessages(assistantConfig?.chat_jid || ''));
  recoverPendingMessages();
  startMessageLoop();
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info('ChessClaw running');

  while (true) {
    try {
      const chatJid = assistantConfig?.chat_jid;
      if (!chatJid) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
        continue;
      }

      const { messages, newTimestamp } = getNewMessages(chatJid, lastTimestamp);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        const allPending = getMessagesSince(chatJid, lastAgentTimestamp);
        const messagesToSend = allPending.length > 0 ? allPending : messages;
        const formatted = formatMessages(messagesToSend);

        if (queue.sendMessage(formatted)) {
          logger.debug({ chatJid, count: messagesToSend.length }, 'Piped messages to active container');
          lastAgentTimestamp = messagesToSend[messagesToSend.length - 1].timestamp;
          saveState();
        } else {
          queue.enqueueMessageCheck();
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in the configured chat.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  const chatJid = assistantConfig?.chat_jid;
  if (!chatJid) return;

  const pending = getMessagesSince(chatJid, lastAgentTimestamp);
  if (pending.length > 0) {
    logger.info({ chatJid, pendingCount: pending.length }, 'Recovery: found unprocessed messages');
    queue.enqueueMessageCheck();
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Apple Container system started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Apple Container system failed to start                 ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without Apple Container. To fix:           ║',
      );
      console.error(
        '║  1. Install from: https://github.com/apple/container/releases ║',
      );
      console.error(
        '║  2. Run: container system start                               ║',
      );
      console.error(
        '║  3. Restart ChessClaw                                         ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Apple Container system is required but failed to start');
    }
  }

  // Kill and clean up orphaned ChessClaw containers from previous runs
  try {
    const output = execSync('container ls --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] = JSON.parse(output || '[]');
    const orphans = containers
      .filter((c) => c.status === 'running' && c.configuration.id.startsWith('chessclaw-'))
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(`container stop ${name}`, { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopTelegram();
    await queue.shutdown(10000);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await startTelegramRuntime();
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start ChessClaw');
  process.exit(1);
});
