import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR } from './config.js';
import { AssistantConfig, NewMessage, ScheduledTask, TaskRunLog } from './types.js';

let db: Database.Database;

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      chat_jid TEXT NOT NULL,
      name TEXT,
      added_at TEXT NOT NULL,
      requires_trigger INTEGER DEFAULT 0,
      container_timeout INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      key TEXT PRIMARY KEY CHECK (key = 'assistant'),
      session_id TEXT NOT NULL
    );
  `);

  migrateLegacyState();
}

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
    return;
  }

  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      last_message_time = MAX(last_message_time, excluded.last_message_time)
  `,
  ).run(chatJid, chatJid, timestamp);
}

export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

export function storeMessageDirect(msg: {
  id: string;
  chatJid: string,
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chatJid,
    msg.sender,
    msg.senderName,
    msg.content,
    msg.timestamp,
    msg.isFromMe ? 1 : 0,
  );
}

export function storeMessage(
  msg: {
    id: string;
    chatJid: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
  },
): void {
  storeMessageDirect(msg);
}

export function getNewMessages(
  chatJid: string,
  lastTimestamp: string,
): { messages: NewMessage[]; newTimestamp: string } {
  const rows = db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, content, timestamp
      FROM messages
      WHERE timestamp > ? AND chat_jid = ? AND is_from_me = 0
      ORDER BY timestamp
    `,
    )
    .all(lastTimestamp, chatJid) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
): NewMessage[] {
  return db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, content, timestamp
      FROM messages
      WHERE chat_jid = ? AND timestamp > ? AND is_from_me = 0
      ORDER BY timestamp
    `,
    )
    .all(chatJid, sinceTimestamp) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, prompt, schedule_type, schedule_value, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'>
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTask(id: string): void {
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  return db
    .prepare(
      `
      SELECT * FROM scheduled_tasks
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run
    `,
    )
    .all(new Date().toISOString()) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

export function getSession(): string | undefined {
  const row = db
    .prepare(`SELECT session_id FROM sessions WHERE key = 'assistant'`)
    .get() as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(sessionId: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO sessions (key, session_id) VALUES ('assistant', ?)`,
  ).run(sessionId);
}

export function getAssistantConfig(): AssistantConfig | undefined {
  const row = db
    .prepare(
      `
      SELECT chat_jid, name, added_at, requires_trigger, container_timeout
      FROM assistant_state
      WHERE id = 1
    `,
    )
    .get() as
    | {
        chat_jid: string;
        name: string | null;
        added_at: string;
        requires_trigger: number | null;
        container_timeout: number | null;
      }
    | undefined;

  if (!row) return undefined;
  return {
    chat_jid: row.chat_jid,
    name: row.name || undefined,
    added_at: row.added_at,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    containerTimeout: row.container_timeout || undefined,
  };
}

export function setAssistantConfig(config: AssistantConfig): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO assistant_state (id, chat_jid, name, added_at, requires_trigger, container_timeout)
    VALUES (1, ?, ?, ?, ?, ?)
  `,
  ).run(
    config.chat_jid,
    config.name || null,
    config.added_at,
    config.requiresTrigger === undefined ? 0 : config.requiresTrigger ? 1 : 0,
    config.containerTimeout || null,
  );
}

function migrateLegacyState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  const routerState = migrateFile('router_state.json') as
    | {
        last_timestamp?: string;
        last_agent_timestamp?: string | Record<string, string>;
      }
    | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (typeof routerState.last_agent_timestamp === 'string') {
      setRouterState('last_agent_timestamp', routerState.last_agent_timestamp);
    } else if (routerState.last_agent_timestamp) {
      const firstTimestamp = Object.values(routerState.last_agent_timestamp)
        .filter((value): value is string => typeof value === 'string')
        .sort()
        .at(-1);
      if (firstTimestamp) {
        setRouterState('last_agent_timestamp', firstTimestamp);
      }
    }
  }

  const sessions = migrateFile('sessions.json') as Record<string, string> | null;
  if (sessions) {
    const sessionId = Object.values(sessions)[0];
    if (sessionId) setSession(sessionId);
  }

  const groups = migrateFile('registered_groups.json') as
    | Record<
        string,
        {
          name?: string;
          added_at?: string;
          requiresTrigger?: boolean;
          containerConfig?: { timeout?: number };
        }
      >
    | null;
  if (groups && !getAssistantConfig()) {
    const [chatJid, group] = Object.entries(groups)[0] || [];
    if (chatJid) {
      setAssistantConfig({
        chat_jid: chatJid,
        name: group?.name,
        added_at: group?.added_at || new Date().toISOString(),
        requiresTrigger: group?.requiresTrigger,
        containerTimeout: group?.containerConfig?.timeout,
      });
    }
  }
}
