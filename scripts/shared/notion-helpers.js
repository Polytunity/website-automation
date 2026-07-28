/**
 * Strip HTML tags and decode common HTML entities to plain text.
 * Squarespace body content comes back as raw HTML — this cleans it up
 * so the definition reads naturally inside Notion.
 */
function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&lsquo;/g, "\u2018")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&hellip;/g, "…");
}

function stripHtml(html) {
  if (!html) return "";
  return decodeEntities(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Notion text blocks have a 2000-character limit per element.
 * This splits a long string into an array of rich_text objects that
 * Notion's API will accept.
 */
function toRichText(text) {
  const CHUNK_SIZE = 2000;
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push({
      type: "text",
      text: { content: text.slice(i, i + CHUNK_SIZE) },
    });
  }
  return chunks.length > 0 ? chunks : [{ type: "text", text: { content: "" } }];
}

function parseInlineHtml(html) {
  if (!html) return [{ type: "text", text: { content: "" } }];
  const segments = [];
  const tokenRegex = /<(\/?)(?:(strong|b)|(em|i)|(a)\s+href="([^"]*)")>/gi;
  let lastIndex = 0;
  let isBold = false;
  let isItalic = false;
  let linkUrl = null;
  let match;

  while ((match = tokenRegex.exec(html)) !== null) {
    const before = html.slice(lastIndex, match.index);
    if (before) {
      const plain = decodeEntities(before.replace(/<[^>]+>/g, ""));
      if (plain) {
        segments.push({
          type: "text",
          text: { content: plain, ...(linkUrl ? { link: { url: linkUrl } } : {}) },
          annotations: { bold: isBold, italic: isItalic },
        });
      }
    }
    const isClosing = match[1] === "/";
    if (match[2]) isBold = !isClosing;
    if (match[3]) isItalic = !isClosing;
    if (match[4] && !isClosing) {
        const href = match[5];
        // Only use as a link if it's an absolute URL — Notion rejects relative URLs
        linkUrl = href.startsWith("http://") || href.startsWith("https://") ? href : null;
    }
    if (match[4] && isClosing) linkUrl = null;
    lastIndex = tokenRegex.lastIndex;
  }

  const tail = html.slice(lastIndex);
  if (tail) {
    const plain = decodeEntities(tail.replace(/<[^>]+>/g, ""));
    if (plain) {
      segments.push({
        type: "text",
        text: { content: plain },
        annotations: { bold: isBold, italic: isItalic },
      });
    }
  }
  return segments.length > 0 ? segments : [{ type: "text", text: { content: "" } }];
}

function htmlToNotionBlocks(html) {
  if (!html) return [];
  const blocks = [];
  const flat = html.replace(/[\r\n\t]+/g, " ");
  const blockRegex = /<(h[1-3]|p|ul|ol|blockquote|hr)(\s[^>]*)?>[\s\S]*?<\/\1>|<hr\s*\/?>/gi;
  let match;

  while ((match = blockRegex.exec(flat)) !== null) {
    const raw = match[0];
    const tag = match[1]?.toLowerCase();

    if (tag === "h1" || tag === "h2" || tag === "h3") {
      const text = decodeEntities(raw.replace(/<[^>]+>/g, "").trim());
      if (!text) continue;
      const level = tag === "h1" ? "heading_1" : tag === "h2" ? "heading_2" : "heading_3";
      blocks.push({
        object: "block", type: level,
        [level]: { rich_text: [{ type: "text", text: { content: text.slice(0, 2000) } }] },
      });
    } else if (tag === "p") {
      const innerHtml = raw.replace(/^<p[^>]*>/i, "").replace(/<\/p>$/i, "").trim();
      if (!innerHtml || /^\s*$/.test(stripHtml(innerHtml))) continue;
      blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: parseInlineHtml(innerHtml) } });
    } else if (tag === "ul") {
      const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let li;
      while ((li = liRegex.exec(raw)) !== null) {
        blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: parseInlineHtml(li[1].trim()) } });
      }
    } else if (tag === "ol") {
      const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let li;
      while ((li = liRegex.exec(raw)) !== null) {
        blocks.push({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: parseInlineHtml(li[1].trim()) } });
      }
    } else if (tag === "blockquote") {
      const text = stripHtml(raw.replace(/^<blockquote[^>]*>/i, "").replace(/<\/blockquote>$/i, "").trim());
      if (!text) continue;
      blocks.push({ object: "block", type: "quote", quote: { rich_text: toRichText(text) } });
    } else if (!tag || raw.toLowerCase().startsWith("<hr")) {
      blocks.push({ object: "block", type: "divider", divider: {} });
    }
  }
  return blocks;
}

function makeReplacePageBody(notion, sleep) {
  return async function replacePageBody(pageId, blocks) {
    let existingBlocks = [];
    let cursor = undefined;
    do {
      const res = await notion.blocks.children.list({ block_id: pageId, start_cursor: cursor });
      existingBlocks = existingBlocks.concat(res.results);
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    for (const block of existingBlocks) {
      await notion.blocks.delete({ block_id: block.id });
      await sleep(50);
    }

    const BATCH_SIZE = 100;
    for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
      await notion.blocks.children.append({ block_id: pageId, children: blocks.slice(i, i + BATCH_SIZE) });
      await sleep(100);
    }
  };
}

module.exports = {
  decodeEntities,
  stripHtml,
  toRichText,
  parseInlineHtml,
  htmlToNotionBlocks,
  makeReplacePageBody,
};