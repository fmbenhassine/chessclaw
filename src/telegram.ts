import fs from 'fs';

import { Bot, Context, InputFile } from 'grammy';

import { logger } from './logger.js';

let bot: Bot | null = null;
const SEND_RETRY_DELAYS_MS = [0, 1000, 3000];

export interface TelegramIncomingMessage {
  id: string;
  chatJid: string;
  chatName?: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
}

export interface ConnectTelegramOptions {
  botToken: string;
  onMessage: (message: TelegramIncomingMessage) => Promise<void> | void;
}

function toChatJid(chatId: number | string): string {
  return `tg:${chatId}`;
}

function fromChatJid(chatJid: string): number | string {
  if (!chatJid.startsWith('tg:')) {
    throw new Error(`Invalid Telegram chat ID: ${chatJid}`);
  }

  const raw = chatJid.slice(3);
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : raw;
}

function getChatName(ctx: Context): string | undefined {
  const chat = ctx.chat;
  if (!chat) return undefined;

  if ('title' in chat && typeof chat.title === 'string' && chat.title.trim()) {
    return chat.title.trim();
  }

  const firstName = 'first_name' in chat ? chat.first_name?.trim() : '';
  const lastName = 'last_name' in chat ? chat.last_name?.trim() : '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;

  if ('username' in chat && typeof chat.username === 'string' && chat.username.trim()) {
    return `@${chat.username.trim()}`;
  }

  return undefined;
}

function getSenderName(ctx: Context): string {
  const from = ctx.from;
  if (!from) return 'unknown';

  const fullName = [from.first_name?.trim(), from.last_name?.trim()]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (fullName) return fullName;
  if (from.username?.trim()) return `@${from.username.trim()}`;
  return String(from.id);
}

function getMessageContent(ctx: Context): string {
  const msg = ctx.msg;
  if (!msg) return '[Unsupported message]';

  if ('text' in msg && typeof msg.text === 'string' && msg.text.trim()) {
    return msg.text;
  }

  if ('caption' in msg && typeof msg.caption === 'string' && msg.caption.trim()) {
    return msg.caption;
  }

  if ('photo' in msg && msg.photo) return '[Photo]';
  if ('video' in msg && msg.video) return '[Video]';
  if ('voice' in msg && msg.voice) return '[Voice message]';
  if ('audio' in msg && msg.audio) return '[Audio]';
  if ('sticker' in msg && msg.sticker) return '[Sticker]';
  if ('animation' in msg && msg.animation) return '[Animation]';
  if ('document' in msg && msg.document) {
    const filename = msg.document.file_name?.trim();
    return filename ? `[Document: ${filename}]` : '[Document]';
  }
  if ('location' in msg && msg.location) return '[Location]';
  if ('contact' in msg && msg.contact) return '[Contact]';
  if ('poll' in msg && msg.poll) return `[Poll: ${msg.poll.question}]`;

  return '[Unsupported message]';
}

function buildIncomingMessage(ctx: Context): TelegramIncomingMessage | null {
  const msg = ctx.msg;
  const chat = ctx.chat;
  const from = ctx.from;
  if (!msg || !chat) return null;

  return {
    id: String(msg.message_id),
    chatJid: toChatJid(chat.id),
    chatName: getChatName(ctx),
    sender: from ? `tg-user:${from.id}` : toChatJid(chat.id),
    senderName: getSenderName(ctx),
    content: getMessageContent(ctx),
    timestamp: new Date(msg.date * 1000).toISOString(),
    isFromMe: false,
  };
}

function splitMessage(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    const end = breakAt > maxLength * 0.6 ? breakAt : maxLength;
    chunks.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function retryTelegramCall<T>(
  action: string,
  fn: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < SEND_RETRY_DELAYS_MS.length; attempt += 1) {
    const delayMs = SEND_RETRY_DELAYS_MS[attempt];
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;
      logger.warn(
        { action, attempt: attempt + 1, err },
        'Telegram API call failed',
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Telegram API call failed for action: ${action}`);
}

export function toTelegramChatJid(chatId: number | string): string {
  return toChatJid(chatId);
}

export async function connectTelegram(
  options: ConnectTelegramOptions,
): Promise<void> {
  if (!options.botToken.trim()) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const instance = new Bot(options.botToken);

  instance.catch((err) => {
    logger.error({ err }, 'Telegram bot error');
  });

  instance.command('chatid', async (ctx) => {
    if (!ctx.chat) return;
    await ctx.reply(`Assistant chat ID: ${toChatJid(ctx.chat.id)}`);
  });

  instance.on('message', async (ctx) => {
    if (ctx.from?.is_bot) return;
    if ('text' in ctx.msg && typeof ctx.msg.text === 'string' && ctx.msg.text.startsWith('/chatid')) {
      return;
    }

    const incoming = buildIncomingMessage(ctx);
    if (!incoming) return;

    await options.onMessage(incoming);
  });

  await instance.init();
  bot = instance;

  const username = instance.botInfo?.username || '(unknown)';
  logger.info({ username }, 'Connected to Telegram');

  instance
    .start({
      drop_pending_updates: true,
      onStart: () => {
        logger.info({ username }, 'Telegram polling started');
      },
    })
    .catch((err) => {
      logger.error({ err }, 'Telegram polling exited unexpectedly');
    });
}

export async function sendTelegramMessage(
  chatJid: string,
  text: string,
): Promise<void> {
  if (!bot) {
    throw new Error('Telegram bot is not connected');
  }

  const chatId = fromChatJid(chatJid);
  for (const chunk of splitMessage(text)) {
    await retryTelegramCall('sendMessage', () =>
      bot!.api.sendMessage(chatId, chunk),
    );
  }
}

export async function sendTelegramImage(
  chatJid: string,
  imagePath: string,
  caption?: string,
): Promise<void> {
  if (!bot) {
    throw new Error('Telegram bot is not connected');
  }
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  await retryTelegramCall('sendPhoto', () =>
    bot!.api.sendPhoto(fromChatJid(chatJid), new InputFile(imagePath), {
      ...(caption ? { caption } : {}),
    }),
  );
}

export async function setTelegramTyping(
  chatJid: string,
  isTyping: boolean,
): Promise<void> {
  if (!bot || !isTyping) return;
  await bot.api.sendChatAction(fromChatJid(chatJid), 'typing');
}

export function stopTelegram(): void {
  bot?.stop();
  bot = null;
}
