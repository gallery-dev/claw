import { Api, Bot, Context, GrammyError, HttpError } from 'grammy';
import { apiThrottler } from '@grammyjs/transformer-throttler';

import {
  ASSISTANT_NAME,
  TELEGRAM_ALLOWED_USERS,
  TELEGRAM_DM_POLICY,
} from '../config.js';
import { updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { Channel, MediaAttachment, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';
import { markdownToTelegramHtml, formatAndChunk, escapeHtml } from './telegram-format.js';

/** Telegram Bot API message text limit */
const MAX_MESSAGE_LENGTH = 4096;

/** Throttle streaming edits to avoid Telegram rate limits */
const STREAM_THROTTLE_MS = 1200;

/** Max retries for API calls */
const MAX_RETRIES = 3;

/** Fragment reassembly: max gap between consecutive messages (ms) */
const FRAGMENT_MAX_GAP_MS = 1500;
/** Fragment reassembly: max sequential message ID gap */
const FRAGMENT_MAX_ID_GAP = 1;
/** Fragment reassembly: max parts to reassemble */
const FRAGMENT_MAX_PARTS = 12;
/** Fragment reassembly: max total chars */
const FRAGMENT_MAX_CHARS = 50_000;

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  botToken: string;
  /** Called when a Telegram DM arrives from a user who passes policy checks
   *  but whose chat isn't registered yet. index.ts uses this to auto-register. */
  onAutoRegisterDm?: (jid: string, senderName: string) => void;
}

// ── JID helpers ────────────────────────────────────────────────────

function toJid(chatId: number): string {
  return `tg:${chatId}`;
}

function fromJid(jid: string): number {
  return parseInt(jid.replace('tg:', ''), 10);
}

// ── Retry logic ────────────────────────────────────────────────────

/** Error codes that are safe to retry */
const RECOVERABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
]);

function isRecoverableError(err: unknown): boolean {
  if (err instanceof GrammyError) {
    // 429 Too Many Requests — respect retry_after
    if (err.error_code === 429) return true;
    // 5xx server errors
    if (err.error_code >= 500) return true;
    return false;
  }
  if (err instanceof HttpError) return true;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && RECOVERABLE_CODES.has(code)) return true;
  }
  return false;
}

function isTelegramHtmlParseError(err: unknown): boolean {
  if (err instanceof GrammyError) {
    const desc = err.description?.toLowerCase() ?? '';
    return desc.includes('can\'t parse') || desc.includes('parse entities');
  }
  return false;
}

function isTelegramThreadNotFoundError(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return err.description?.includes('message thread not found') ?? false;
  }
  return false;
}

function getRetryAfter(err: unknown): number {
  if (err instanceof GrammyError && err.error_code === 429) {
    const params = (err as any).parameters;
    return (params?.retry_after ?? 5) * 1000;
  }
  return 0;
}

async function retryCall<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRecoverableError(err)) throw err;

      const retryAfterMs = getRetryAfter(err);
      const delayMs = retryAfterMs || (1000 * Math.pow(2, attempt) + Math.random() * 500);
      logger.warn(
        { attempt: attempt + 1, label, delay: delayMs, err },
        'Retrying Telegram API call',
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ── Message chunking ───────────────────────────────────────────────

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

    const paraIdx = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    if (paraIdx > MAX_MESSAGE_LENGTH * 0.3) {
      splitAt = paraIdx + 2;
    }

    if (splitAt === -1) {
      const nlIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      if (nlIdx > MAX_MESSAGE_LENGTH * 0.3) {
        splitAt = nlIdx + 1;
      }
    }

    if (splitAt === -1) {
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

// ── Fragment reassembly ────────────────────────────────────────────

interface FragmentBuffer {
  chatId: number;
  senderId: number;
  lastMessageId: number;
  lastTime: number;
  parts: string[];
  totalChars: number;
  /** Telegram message_id of the first fragment (for reply threading) */
  firstPlatformMessageId: number;
  flushTimer: ReturnType<typeof setTimeout>;
}

// ── Streaming state ────────────────────────────────────────────────

interface StreamState {
  messageId?: number;
  text: string;
  lastEditTime: number;
  chatId: number;
}

// ── Bot pool for agent swarm ───────────────────────────────────────

/** Send-only Api instances for pool bots (no polling) */
const poolApis: Api[] = [];
/** Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment */
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot's sendMessage via channel
    logger.warn('No pool bots available, cannot send pool message');
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned and renamed pool bot');
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_MESSAGE_LENGTH));
      }
    }
    logger.info({ chatId, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

// ── Channel class ──────────────────────────────────────────────────

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot;
  private connected = false;
  private opts: TelegramChannelOpts;
  private fragments = new Map<string, FragmentBuffer>();
  private streams = new Map<string, StreamState>();

  constructor(opts: TelegramChannelOpts) {
    this.opts = opts;
    this.bot = new Bot(opts.botToken);

    // Rate limiter — prevents hitting Telegram's API limits
    // NOTE: apiThrottler wraps ALL api calls including getUpdates.
    // Only install it after polling is running to avoid interference.
    this.throttlerInstalled = false;
  }

  private throttlerInstalled: boolean;

  async connect(): Promise<void> {
    // Raw update logger — fires for EVERY update received from Telegram
    this.bot.use((ctx, next) => {
      const updateKeys = Object.keys(ctx.update).filter((k) => k !== 'update_id');
      logger.debug(
        { updateId: ctx.update.update_id, types: updateKeys },
        'Telegram update received',
      );
      return next();
    });

    // Bot commands (registered before general message handler)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const jid = toJid(chatId);
      const type = ctx.chat.type;
      const name = type === 'private'
        ? ctx.from?.first_name ?? 'DM'
        : (ctx.chat as { title?: string }).title ?? 'Unknown';
      const groups = this.opts.registeredGroups();
      const registered = !!groups[jid];
      ctx.reply(
        `<b>JID:</b> <code>${escapeHtml(jid)}</code>\n` +
        `<b>Type:</b> ${type}\n` +
        `<b>Name:</b> ${escapeHtml(name)}\n` +
        `<b>Registered:</b> ${registered ? 'yes' : 'no'}`,
        { parse_mode: 'HTML' },
      ).catch((err) => logger.debug({ err }, '/chatid reply failed'));
    });

    this.bot.command('ping', (ctx) => {
      ctx.reply('pong').catch((err) => logger.debug({ err }, '/ping reply failed'));
    });

    // Handle all message types (text, caption, photo, document, audio, video, voice, sticker)
    this.bot.on('message', (ctx) => this.handleMessage(ctx));

    // Handle reaction updates
    this.bot.on('message_reaction', (ctx) => {
      const update = ctx.messageReaction;
      if (!update) return;
      logger.debug(
        { chatId: update.chat.id, messageId: update.message_id },
        'Reaction received',
      );
    });

    // Error handler
    this.bot.catch((err) => {
      logger.error({ err: err.error, update: err.ctx?.update?.update_id }, 'Telegram bot error');
    });

    // Start long polling (not awaited — runs in background)
    logger.info('Starting Telegram long polling...');
    this.bot.start({
      allowed_updates: ['message', 'message_reaction'],
      onStart: (botInfo) => {
        this.connected = true;
        logger.info({ username: botInfo.username, dmPolicy: TELEGRAM_DM_POLICY }, 'Connected to Telegram');

        // Install throttler AFTER polling is established to avoid
        // interfering with the initial getUpdates setup
        if (!this.throttlerInstalled) {
          this.bot.api.config.use(apiThrottler());
          this.throttlerInstalled = true;
          logger.debug('API throttler installed');
        }
      },
    }).then(() => {
      // bot.start() resolves when bot.stop() is called — should not happen unexpectedly
      logger.warn('Telegram polling loop ended');
      this.connected = false;
    }).catch((err) => {
      logger.error({ err }, 'Telegram bot polling crashed');
      this.connected = false;
      // Auto-reconnect after 5 seconds
      setTimeout(() => {
        logger.info('Attempting Telegram bot reconnect...');
        this.bot.start({ drop_pending_updates: true })
          .then(() => {
            this.connected = false;
            logger.warn('Telegram bot polling stopped');
          })
          .catch((reconnectErr) => {
            logger.error({ err: reconnectErr }, 'Telegram bot reconnect failed');
            this.connected = false;
          });
        this.connected = true;
      }, 5000);
    });
  }

  // ── Inbound message handling ───────────────────────────────────

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

    // Auto-register Telegram DMs that pass policy checks
    let groups = this.opts.registeredGroups();
    if (!groups[jid] && isDm && this.opts.onAutoRegisterDm) {
      const senderName = msg.from
        ? (msg.from.first_name + (msg.from.last_name ? ` ${msg.from.last_name}` : ''))
        : 'Telegram DM';
      this.opts.onAutoRegisterDm(jid, senderName);
      groups = this.opts.registeredGroups(); // Refresh after registration
    }

    // Only deliver full message for registered groups
    if (!groups[jid]) return;

    // --- Extract content and media ---
    const textContent = msg.text || msg.caption || '';
    const media = this.extractMedia(msg);

    // Skip messages with no text and no media
    if (!textContent && media.length === 0) return;

    // Build content string including media descriptions
    let content = textContent;
    if (media.length > 0 && !textContent) {
      content = media.map((m) => `[${m.type}${m.fileName ? `: ${m.fileName}` : ''}]`).join(' ');
    }

    if (!content) return;

    // --- Group mention gating ---
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
          return;
        }

        if (hasMention && !hasTrigger && mentionPattern) {
          normalizedContent = content.replace(mentionPattern, `@${ASSISTANT_NAME}`);
        }
      }
    }

    const sender = msg.from ? `tg:${msg.from.id}` : jid;
    const senderName = msg.from
      ? (msg.from.first_name + (msg.from.last_name ? ` ${msg.from.last_name}` : ''))
      : 'Unknown';
    const fromMe = msg.from?.id === this.bot.botInfo?.id;
    const isBotMessage = fromMe;
    const platformMessageId = msg.message_id;

    // --- Fragment reassembly ---
    if (msg.from && !fromMe) {
      const fragKey = `${chatId}:${msg.from.id}`;
      const existing = this.fragments.get(fragKey);

      if (
        existing &&
        msg.message_id - existing.lastMessageId <= FRAGMENT_MAX_ID_GAP &&
        Date.now() - existing.lastTime < FRAGMENT_MAX_GAP_MS &&
        existing.parts.length < FRAGMENT_MAX_PARTS &&
        existing.totalChars + normalizedContent.length < FRAGMENT_MAX_CHARS
      ) {
        // Accumulate fragment
        clearTimeout(existing.flushTimer);
        existing.parts.push(normalizedContent);
        existing.lastMessageId = msg.message_id;
        existing.lastTime = Date.now();
        existing.totalChars += normalizedContent.length;
        existing.flushTimer = setTimeout(() => this.flushFragment(fragKey, jid, sender, senderName, timestamp, media), FRAGMENT_MAX_GAP_MS);
        return;
      }

      // Flush any existing fragment for this sender
      if (existing) {
        clearTimeout(existing.flushTimer);
        this.flushFragment(fragKey, jid, sender, senderName, timestamp, []);
      }

      // Check if this message might be the start of a fragment
      if (normalizedContent.length >= 4000) {
        this.fragments.set(fragKey, {
          chatId,
          senderId: msg.from.id,
          lastMessageId: msg.message_id,
          lastTime: Date.now(),
          parts: [normalizedContent],
          totalChars: normalizedContent.length,
          firstPlatformMessageId: platformMessageId,
          flushTimer: setTimeout(() => this.flushFragment(fragKey, jid, sender, senderName, timestamp, media), FRAGMENT_MAX_GAP_MS),
        });
        return;
      }
    }

    // --- Deliver single message ---
    this.opts.onMessage(jid, {
      id: String(msg.message_id),
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content: normalizedContent,
      timestamp,
      is_from_me: fromMe,
      is_bot_message: isBotMessage,
      platform_message_id: platformMessageId,
      media: media.length > 0 ? media : undefined,
    });
  }

  private flushFragment(
    fragKey: string,
    jid: string,
    sender: string,
    senderName: string,
    timestamp: string,
    media: MediaAttachment[],
  ): void {
    const frag = this.fragments.get(fragKey);
    if (!frag) return;
    this.fragments.delete(fragKey);

    const combined = frag.parts.join('\n');
    logger.debug(
      { chatId: frag.chatId, parts: frag.parts.length, totalChars: combined.length },
      'Flushed reassembled message fragments',
    );

    this.opts.onMessage(jid, {
      id: String(frag.firstPlatformMessageId),
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content: combined,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
      platform_message_id: frag.firstPlatformMessageId,
      media: media.length > 0 ? media : undefined,
    });
  }

  // ── Media extraction ─────────────────────────────────────────────

  private extractMedia(msg: NonNullable<Context['message']>): MediaAttachment[] {
    const media: MediaAttachment[] = [];

    if (msg.photo && msg.photo.length > 0) {
      // Use largest photo (last in array)
      const largest = msg.photo[msg.photo.length - 1];
      media.push({
        type: 'photo',
        fileId: largest.file_id,
        fileSize: largest.file_size,
      });
    }

    if (msg.document) {
      media.push({
        type: 'document',
        fileId: msg.document.file_id,
        fileName: msg.document.file_name,
        mimeType: msg.document.mime_type,
        fileSize: msg.document.file_size,
      });
    }

    if (msg.audio) {
      media.push({
        type: 'audio',
        fileId: msg.audio.file_id,
        fileName: msg.audio.file_name,
        mimeType: msg.audio.mime_type,
        fileSize: msg.audio.file_size,
      });
    }

    if (msg.video) {
      media.push({
        type: 'video',
        fileId: msg.video.file_id,
        fileName: msg.video.file_name,
        mimeType: msg.video.mime_type,
        fileSize: msg.video.file_size,
      });
    }

    if (msg.voice) {
      media.push({
        type: 'voice',
        fileId: msg.voice.file_id,
        mimeType: msg.voice.mime_type,
        fileSize: msg.voice.file_size,
      });
    }

    if (msg.sticker) {
      media.push({
        type: 'sticker',
        fileId: msg.sticker.file_id,
        fileSize: msg.sticker.file_size,
      });
    }

    return media;
  }

  // ── Outbound: send message (with HTML formatting + fallback) ───

  async sendMessage(jid: string, text: string, replyToMessageId?: number): Promise<void> {
    const chatId = fromJid(jid);
    const chunks = formatAndChunk(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const replyParams = i === 0 && replyToMessageId
        ? { reply_parameters: { message_id: replyToMessageId } }
        : {};

      await this.sendWithHtmlFallback(chatId, chunk.html, chunk.plain, replyParams);
    }
    logger.info({ jid, length: text.length, chunks: chunks.length }, 'Telegram message sent');
  }

  private async sendWithHtmlFallback(
    chatId: number,
    html: string,
    plain: string,
    extraParams: Record<string, unknown> = {},
  ): Promise<number> {
    try {
      const sent = await retryCall(
        () => this.bot.api.sendMessage(chatId, html, {
          parse_mode: 'HTML',
          ...extraParams,
        }),
        'sendMessage-html',
      );
      return sent.message_id;
    } catch (err) {
      if (isTelegramHtmlParseError(err)) {
        logger.warn({ chatId }, 'HTML parse failed, falling back to plain text');
        // Retry without reply_parameters if thread not found
        try {
          const sent = await retryCall(
            () => this.bot.api.sendMessage(chatId, plain, extraParams),
            'sendMessage-plain',
          );
          return sent.message_id;
        } catch (err2) {
          if (isTelegramThreadNotFoundError(err2)) {
            const { reply_parameters: _, ...noReply } = extraParams;
            const sent = await retryCall(
              () => this.bot.api.sendMessage(chatId, plain, noReply),
              'sendMessage-plain-nothread',
            );
            return sent.message_id;
          }
          throw err2;
        }
      }
      // Thread not found — retry without reply
      if (isTelegramThreadNotFoundError(err)) {
        const { reply_parameters: _, ...noReply } = extraParams;
        const sent = await retryCall(
          () => this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...noReply }),
          'sendMessage-html-nothread',
        );
        return sent.message_id;
      }
      throw err;
    }
  }

  // ── Streaming: send → edit → edit → ... → finalize ─────────────

  async sendStreamingChunk(jid: string, text: string, messageId?: number, replyToMessageId?: number): Promise<number> {
    const chatId = fromJid(jid);
    const html = markdownToTelegramHtml(text);

    // Trim to Telegram's limit
    const trimmedHtml = html.length > MAX_MESSAGE_LENGTH
      ? html.slice(0, MAX_MESSAGE_LENGTH - 3) + '...'
      : html;

    if (messageId == null) {
      // First chunk — send new message (with reply threading if available)
      const replyParams = replyToMessageId
        ? { reply_parameters: { message_id: replyToMessageId } }
        : {};
      const sent = await this.sendWithHtmlFallback(chatId, trimmedHtml, text, replyParams);
      this.streams.set(jid, {
        messageId: sent,
        text,
        lastEditTime: Date.now(),
        chatId,
      });
      return sent;
    }

    // Subsequent chunks — throttle edits
    const stream = this.streams.get(jid);
    const now = Date.now();
    if (stream && now - stream.lastEditTime < STREAM_THROTTLE_MS) {
      // Too soon — just update local state, skip API call
      stream.text = text;
      return messageId;
    }

    try {
      await retryCall(
        () => this.bot.api.editMessageText(chatId, messageId, trimmedHtml, {
          parse_mode: 'HTML',
        }),
        'editMessageText-stream',
      );
    } catch (err) {
      // "message is not modified" is a no-op
      if (err instanceof GrammyError && err.description?.includes('not modified')) {
        // Silently ignore
      } else if (isTelegramHtmlParseError(err)) {
        // Fallback to plain text edit
        const plain = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH - 3) + '...' : text;
        try {
          await retryCall(
            () => this.bot.api.editMessageText(chatId, messageId, plain),
            'editMessageText-plain',
          );
        } catch {
          // Give up silently — next edit will try again
        }
      } else {
        logger.debug({ jid, err }, 'Streaming edit failed');
      }
    }

    if (stream) {
      stream.text = text;
      stream.lastEditTime = now;
    }

    return messageId;
  }

  async finalizeStream(jid: string, messageId: number, text: string): Promise<void> {
    const chatId = fromJid(jid);
    this.streams.delete(jid);

    // If text exceeds limit, we need to split into chunks
    if (text.length > MAX_MESSAGE_LENGTH) {
      const chunks = formatAndChunk(text);
      // Edit first message with first chunk
      try {
        await retryCall(
          () => this.bot.api.editMessageText(chatId, messageId, chunks[0].html, {
            parse_mode: 'HTML',
          }),
          'finalizeStream-edit',
        );
      } catch (err) {
        if (isTelegramHtmlParseError(err)) {
          await retryCall(
            () => this.bot.api.editMessageText(chatId, messageId, chunks[0].plain),
            'finalizeStream-edit-plain',
          ).catch(() => {});
        }
        // Continue with remaining chunks regardless
      }
      // Send remaining chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        await this.sendWithHtmlFallback(chatId, chunks[i].html, chunks[i].plain);
      }
      return;
    }

    // Single chunk — do final edit
    const html = markdownToTelegramHtml(text);
    try {
      await retryCall(
        () => this.bot.api.editMessageText(chatId, messageId, html, {
          parse_mode: 'HTML',
        }),
        'finalizeStream-edit',
      );
    } catch (err) {
      if (err instanceof GrammyError && err.description?.includes('not modified')) {
        // Already up to date
      } else if (isTelegramHtmlParseError(err)) {
        await retryCall(
          () => this.bot.api.editMessageText(chatId, messageId, text),
          'finalizeStream-edit-plain',
        ).catch(() => {});
      } else {
        logger.debug({ jid, err }, 'Stream finalize edit failed');
      }
    }
  }

  // ── Reactions ────────────────────────────────────────────────────

  async sendReaction(jid: string, messageId: number, emoji: string): Promise<void> {
    const chatId = fromJid(jid);
    try {
      await retryCall(
        () => this.bot.api.setMessageReaction(chatId, messageId, [
          { type: 'emoji', emoji } as any,
        ]),
        'setMessageReaction',
      );
    } catch (err) {
      logger.debug({ jid, messageId, emoji, err }, 'Failed to send reaction');
    }
  }

  // ── Standard channel methods ─────────────────────────────────────

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    // Flush all pending fragments before clearing
    for (const [key, frag] of this.fragments) {
      clearTimeout(frag.flushTimer);
      const jid = toJid(frag.chatId);
      const sender = `tg:${frag.senderId}`;
      const timestamp = new Date().toISOString();
      this.flushFragment(key, jid, sender, 'Unknown', timestamp, []);
    }
    this.fragments.clear();
    this.streams.clear();
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
