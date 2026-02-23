/**
 * Markdown → Telegram HTML converter.
 * Converts common markdown patterns to Telegram-supported HTML tags.
 * Based on OpenClaw's format.ts patterns.
 */

// ── HTML Escaping ──────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Markdown → Telegram HTML ───────────────────────────────────────

/**
 * Convert markdown text to Telegram-compatible HTML.
 * Supports: bold, italic, strikethrough, inline code, code blocks,
 * links, and blockquotes.
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return '';

  let html = markdown;

  // 1. Extract and replace code blocks first (protect from further processing)
  const codeBlocks: string[] = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const escaped = escapeHtml(code.replace(/\n$/, '')); // trim trailing newline
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // 2. Extract inline code (protect from further processing)
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`\n]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINECODE_${idx}\x00`;
  });

  // 3. Escape HTML in remaining text
  html = escapeHtml(html);

  // 4. Convert markdown patterns to HTML

  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words with underscores)
  html = html.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
  html = html.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Blockquotes: > text (at start of line)
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Merge consecutive blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // 5. Restore code blocks and inline code
  html = html.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);
  html = html.replace(/\x00INLINECODE_(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)]);

  return html;
}

/**
 * Split formatted text into chunks that fit within Telegram's limit.
 * Returns both HTML and plain text versions for fallback.
 */
export function formatAndChunk(
  markdown: string,
  maxLength = 4096,
): Array<{ html: string; plain: string }> {
  const html = markdownToTelegramHtml(markdown);
  const chunks = chunkHtml(html, maxLength);
  return chunks.map((chunk) => ({
    html: chunk,
    plain: stripHtmlTags(chunk),
  }));
}

/**
 * Split HTML text into chunks respecting the max length.
 * Tries to split on paragraph boundaries, then newlines, then hard-cuts.
 */
function chunkHtml(html: string, maxLength: number): string[] {
  if (html.length <= maxLength) return [html];

  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;

    // Try paragraph break
    const paraIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (paraIdx > maxLength * 0.3) {
      splitAt = paraIdx + 2;
    }

    // Try newline
    if (splitAt === -1) {
      const nlIdx = remaining.lastIndexOf('\n', maxLength);
      if (nlIdx > maxLength * 0.3) {
        splitAt = nlIdx + 1;
      }
    }

    // Hard cut
    if (splitAt === -1) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

/** Strip HTML tags for plain-text fallback */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}
