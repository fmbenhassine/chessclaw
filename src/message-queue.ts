import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { IPC_DIR } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  fn: () => Promise<void>;
}

const INPUT_DIR = path.join(IPC_DIR, 'input');
const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

export class MessageQueue {
  private active = false;
  private pendingMessages = false;
  private pendingTasks: QueuedTask[] = [];
  private currentTaskId: string | null = null;
  private process: ChildProcess | null = null;
  private retryCount = 0;
  private processMessagesFn: (() => Promise<boolean>) | null = null;
  private shuttingDown = false;

  setProcessMessagesFn(fn: () => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(): void {
    if (this.shuttingDown) return;

    if (this.active) {
      this.pendingMessages = true;
      logger.debug('Container active, message queued');
      return;
    }

    this.runMessages('messages');
  }

  enqueueTask(taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    if (this.currentTaskId === taskId || this.pendingTasks.some((task) => task.id === taskId)) {
      logger.debug({ taskId }, 'Task already queued, skipping');
      return;
    }

    if (this.active) {
      this.pendingTasks.push({ id: taskId, fn });
      logger.info({ taskId }, 'Task queued behind active container; requesting container shutdown');
      this.closeStdin();
      return;
    }

    this.runTask({ id: taskId, fn });
  }

  registerProcess(
    proc: ChildProcess,
    _containerName: string,
  ): void {
    this.process = proc;
  }

  sendMessage(text: string): boolean {
    if (!this.active) return false;

    try {
      fs.mkdirSync(INPUT_DIR, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(INPUT_DIR, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(): void {
    if (!this.active) return;

    try {
      fs.mkdirSync(INPUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(INPUT_DIR, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runMessages(reason: 'messages' | 'drain'): Promise<void> {
    this.active = true;
    this.pendingMessages = false;

    logger.debug({ reason }, 'Starting assistant container');

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn();
        if (success) {
          this.retryCount = 0;
        } else {
          this.scheduleRetry();
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error processing assistant messages');
      this.scheduleRetry();
    } finally {
      this.active = false;
      this.process = null;
      this.drain();
    }
  }

  private async runTask(task: QueuedTask): Promise<void> {
    this.active = true;
    this.currentTaskId = task.id;

    logger.debug({ taskId: task.id }, 'Running queued task');

    try {
      await task.fn();
    } catch (err) {
      logger.error({ taskId: task.id, err }, 'Error running task');
    } finally {
      this.active = false;
      this.currentTaskId = null;
      this.process = null;
      this.drain();
    }
  }

  private scheduleRetry(): void {
    this.retryCount++;
    if (this.retryCount > MAX_RETRIES) {
      logger.error(
        { retryCount: this.retryCount },
        'Max retries exceeded, dropping messages until next incoming message',
      );
      this.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, this.retryCount - 1);
    logger.info({ retryCount: this.retryCount, delayMs }, 'Scheduling retry with backoff');
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck();
      }
    }, delayMs);
  }

  private drain(): void {
    if (this.shuttingDown) return;

    if (this.pendingTasks.length > 0) {
      const task = this.pendingTasks.shift()!;
      this.runTask(task);
      return;
    }

    if (this.pendingMessages) {
      this.runMessages('drain');
    }
  }

  async shutdown(_timeoutMs = 0): Promise<void> {
    this.shuttingDown = true;
    this.closeStdin();
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }
}
