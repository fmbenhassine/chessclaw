import path from 'path';

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const ASSISTANT_CHAT_ID = process.env.ASSISTANT_CHAT_ID || '';
export const CHESSCLAW_LICHESS_USERNAME =
  process.env.CHESSCLAW_LICHESS_USERNAME || '';
export const CHESSCLAW_CHESSCOM_USERNAME =
  process.env.CHESSCLAW_CHESSCOM_USERNAME || '';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const ASSISTANT_DIR = path.resolve(PROJECT_ROOT, 'assistant');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const IPC_DIR = path.join(DATA_DIR, 'ipc');
export const SESSION_DIR = path.join(DATA_DIR, 'session', '.codex');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'chessclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '1', 10) || 1,
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
