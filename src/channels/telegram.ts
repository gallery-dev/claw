import { Bot, Context } from 'grammy';

import {
  ASSISTANT_NAME,
  TELEGRAM_ALLOWED_USERS,
  TELEGRAM_DM_POLICY,
} from '../config.js';
import { updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

/** Telegram Bot API message text limit */
const MAX_MESSAGE_LENGTH = 4096;

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  botToken: string;
}

/**
 * Telegram JID format: `tg:<chat_id>`
 * e.g. `tg:-1001234567890` for groups, `tg:123456789` for DMs
 */
function toJid(chatId: number): string {
  return `tg:${chatId}`;
}

function fromJid(jid: string): number {
  return parseInt(jid.replace('tg:', ''), 10);
}

/**
 * Split long text into chunks that fit within Telegram's 4096 char limit.
 * Prefers splitting on paragraph boundaries (double newlines), then
 * single newlines, then hard-cuts at the limit.
 */
function chunkMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;

    // Try double-newline (paragraph break) within limit
    const paraIdx = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    if (paraIdx > MAX_MESSAGE_LENGTH * 0.3) {
      splitAt = paraIdx + 2; // include the newlines
    }

    // Try single newline
    if (splitAt === -1) {
      const nlIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      if (nlIdx > MAX_MESSAGE_LENGTH * 0.3) {
        splitAt = nlIdx + 1;
      }
    }

    // Hard cut
    if (splitAt === -1) {
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot;
  private connected = false;
  private opts: TelegramChannelOpts;

  constructor(opts: TelegramChannelOpts) {
    this.opts = opts;
    this.bot = new Bot(opts.botToken);
  }

  async connect(): Promise<void> {
    // Handle incoming text messages
    this.bot.on('message:text', (ctx) => this.handleMessage(ctx));

    // Handle photo/video captions
    this.bot.on('message:caption', (ctx) => this.handleMessage(ctx));

    // Error handler
    this.bot.catch((err) => {
      logger.error({ err: err.error, update: err.ctx?.update?.update_id }, 'Telegram bot error');
    });

    // Start long polling
    this.bot.start({
      onStart: (botInfo) => {
        this.connected = true;
        logger.info({ username: botInfo.username, dmPolicy: TELEGRAM_DM_POLICY }, 'Connected to Telegram');
      },
    });
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    const chatId = msg.chat.id;
    const jid = toJid(chatId);
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const isDm = msg.chat.type === 'private';
    const chatName = isGroup
      ? (msg.chat as { title?: string }).title
      : undefined;
    const timestamp = new Date(msg.date * 1000).toISOString();

    // --- DM access control ---
    if (isDm) {
      if (TELEGRAM_DM_POLICY === 'disabled') {
        logger.debug({ chatId, sender: msg.from?.id }, 'DM rejected (policy: disabled)');
        return;
      }
      if (TELEGRAM_DM_POLICY === 'allowlist' && msg.from) {
        if (!TELEGRAM_ALLOWED_USERS.has(String(msg.from.id))) {
          logger.debug({ chatId, sender: msg.from.id }, 'DM rejected (not in allowlist)');
          return;
        }
      }
    }

    // Store chat metadata for discovery
    if (chatName) {
      updateChatName(jid, chatName);
    }
    this.opts.onChatMetadata(jid, timestamp, chatName, 'telegram', isGroup);

    // Only deliver full message for registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const content = msg.text || msg.caption || '';
    if (!content) return;

    // --- Group mention gating ---
    // In groups, only process messages that @mention the bot (unless requiresTrigger is false).
    // Normalize @botUsername → @AssistantName so index.ts trigger check passes.
    let normalizedContent = content;
    if (isGroup) {
      const group = groups[jid];
      const requireMention = group.requiresTrigger !== false;

      if (requireMention) {
        const botUsername = this.bot.botInfo?.username;
        const mentionPattern = botUsername ? new RegExp(`@${botUsername}\\b`, 'gi') : null;
        const triggerPattern = new RegExp(`^@${ASSISTANT_NAME}\\b`, 'i');

        const hasMention = mentionPattern && mentionPattern.test(content);
        const hasTrigger = triggerPattern.test(content);

        if (!hasMention && !hasTrigger) {
          return; // Skip — not addressed to the bot
        }

        // Normalize: replace @botUsername with @AssistantName so the
        // router's TRIGGER_PATTERN (^@AssistantName\b) matches correctly
        if (hasMention && !hasTrigger && mentionPattern) {
          normalizedContent = content.replace(mentionPattern, `@${ASSISTANT_NAME}`);
        }
      }
    }

    const sender = msg.from
      ? `tg:${msg.from.id}`
      : jid;
    const senderName = msg.from
      ? (msg.from.first_name + (msg.from.last_name ? ` ${msg.from.last_name}` : ''))
      : 'Unknown';

    const fromMe = msg.from?.id === this.bot.botInfo?.id;
    const isBotMessage = fromMe;

    this.opts.onMessage(jid, {
      id: String(msg.message_id),
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content: normalizedContent,
      timestamp,
      is_from_me: fromMe,
      is_bot_message: isBotMessage,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = fromJid(jid);
    const prefixed = `${ASSISTANT_NAME}: ${text}`;
    const chunks = chunkMessage(prefixed);

    try {
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(chatId, chunk);
      }
      logger.info({ jid, length: text.length, chunks: chunks.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.bot.stop();
  }

  async setTyping(jid: string, _isTyping: boolean): Promise<void> {
    try {
      const chatId = fromJid(jid);
      await this.bot.api.sendChatAction(chatId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send typing action');
    }
  }
}
