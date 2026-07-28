/**
 * sync.js
 * Squarespace Glossary to Notion Database sync script
 *
 * What this does:
 *  1. Fetches all glossary terms from Squarespace's JSON feed (paginated)
 *  2. Fetches the current state of the Notion database
 *  3. For each Squarespace term:
 *     a. If it's NEW: create a new Notion row
 *     b. If it's CHANGED (excerpt differs): fetch full body, strip HTML,
 *        back up old definition to Version Notes, then update the row
 *     c. If UNCHANGED: skip it entirely
 *
 * Environment variables (set as GitHub Actions secrets):
 *   NOTION_GLOSSARY_KEY      – Notion integration secret for glossary database
 *   SQUARESPACE_URL     – base URL, e.g. https://yuen-yuen-ang.squarespace.com (no trailing slash)
 *   NOTION_DATABASE_ID  – your Notion database ID
 */

const { Client } = require("@notionhq/client"); // Notion SDK

// ─── Config ────────────────────────────────────────────────────────────────

const NOTION_GLOSSARY_KEY = process.env.NOTION_GLOSSARY_KEY;
const SQUARESPACE_URL = process.env.SQUARESPACE_URL;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const BLOG_SLUG = "glossary-index"; // the Squarespace blog slug
const DELAY_MS = 250; // delay between per-term fetches (be polite to Squarespace)

const notion = new Client({ auth: NOTION_GLOSSARY_KEY });

// ─── Utilities ─────────────────────────────────────────────────────────────

/** Pause execution for a given number of milliseconds */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// ─── Squarespace fetching ───────────────────────────────────────────────────

/**
 * STEP 1: Fetch all terms from the Squarespace blog JSON feed.
 * Handles pagination automatically — Squarespace returns items in pages
 * of ~20, so we keep fetching until there's no nextPageOffset.
 *
 * Returns an array of objects: { title, excerpt, slug, categories }
 */
async function fetchAllSquarespaceTerms() {
  const baseUrl = `${SQUARESPACE_URL}/${BLOG_SLUG}?format=json`;
  let allItems = [];
  let nextOffset = null;

  console.log("Fetching glossary index from Squarespace...");

  do {
    const url = nextOffset ? `${baseUrl}&offset=${nextOffset}` : baseUrl;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Squarespace index fetch failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    allItems = allItems.concat(data.items || []);
    nextOffset =
      data.pagination && data.pagination.nextPageOffset
        ? data.pagination.nextPageOffset
        : null;
  } while (nextOffset);

  console.log(`Found ${allItems.length} terms on Squarespace.`);

  // Normalise to just the fields we care about
  return allItems.map((item) => ({
    title: item.title.trim(),
    excerpt: stripHtml(item.excerpt || ""),
    // The slug is the last part of fullUrl, e.g. /glossary-index/directed-improvisation
    slug: item.urlId || item.fullUrl.split("/").pop(),
    url: item.fullUrl,
    categories: (item.categories || []).map((c) => c.trim()),
  }));
}

/**
 * STEP 2 (per changed/new term): Fetch the full post body for a single term.
 * We only call this when we know something has changed (excerpt differs),
 * to avoid unnecessary requests.
 */
async function fetchFullBody(slug) {
  const url = `${SQUARESPACE_URL}/${BLOG_SLUG}/${slug}?format=json`;
  const res = await fetch(url);

  if (!res.ok) {
    console.warn(`Could not fetch full body for "${slug}": ${res.status}`);
    return null;
  }

  const data = await res.json();
  const bodyHtml = data.item?.body || data.item?.excerpt || "";
  const blocks = htmlToNotionBlocks(bodyHtml);

  return { bodyHtml, blocks };
}

// ─── Notion fetching ────────────────────────────────────────────────────────

/**
 * STEP 3: Fetch all existing rows from the Notion database.
 * We key them by their Squarespace URL so we can quickly look up
 * whether a term already exists and whether it has changed.
 *
 * Returns a Map: squarespaceUrl → { notionPageId, excerpt, definition, versionNotes }
 */
async function fetchNotionRows() {
  console.log("Fetching existing rows from Notion...");

  const rows = new Map();
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      const props = page.properties;

      // Extract the stored URL so we can match against Squarespace
      const urlProp = props["Squarespace URL"];
      const storedUrl =
        urlProp && urlProp.url ? urlProp.url : null;

      if (!storedUrl) continue;

      // Extract the stored excerpt (we use this to detect changes cheaply)
      const excerptProp = props["Excerpt"];
      const storedExcerpt =
        excerptProp && excerptProp.rich_text
          ? excerptProp.rich_text.map((r) => r.plain_text).join("")
          : "";

      // Extract existing version notes (we'll append to these on updates)
      const versionProp = props["Version Notes"];
      const storedVersionNotes =
        versionProp && versionProp.rich_text
          ? versionProp.rich_text.map((r) => r.plain_text).join("")
          : "";

      rows.set(storedUrl, {
        notionPageId: page.id,
        storedExcerpt,
        storedVersionNotes,
      });
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(`Found ${rows.size} existing rows in Notion.`);
  return rows;
}

// ─── Notion writing ─────────────────────────────────────────────────────────

/**
 * Build the Notion properties object for a glossary term.
 * This is shared between create and update operations.
 */
function buildProperties(term) {
  return {
    "Term": { title: [{ type: "text", text: { content: term.title } }] },
    "Excerpt": { rich_text: toRichText(term.excerpt) },
    "Categories": { multi_select: term.categories.map((cat) => ({ name: cat })) },
    "Squarespace URL": { url: term.url },
    "Last Synced": { date: { start: new Date().toISOString() } },
  };
}

async function replacePageBody(pageId, blocks) {
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
}

/**
 * Create a brand new Notion row for a term we've never seen before.
 */
async function createNotionRow(term, bodyData) {
  console.log(`  ✚ Creating: "${term.title}"`);
  const page = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: buildProperties(term),
    children: bodyData?.blocks?.slice(0, 100) || [],
  });
  if (bodyData?.blocks?.length > 100) {
    await replacePageBody(page.id, bodyData.blocks);
  }
}

/**
 * Update an existing Notion row when a term's content has changed.
 * Before overwriting the definition, we append the OLD definition
 * to Version Notes with a timestamp — this is the revert/history capability.
 */
async function updateNotionRow(term, bodyData, existingRow) {
  console.log(`  ✎ Updating: "${term.title}"`);
  const timestamp = new Date().toISOString().split("T")[0];
  const newVersionEntry = `[${timestamp}] ${existingRow.storedExcerpt}`;
  const updatedVersionNotes = existingRow.storedVersionNotes
    ? `${newVersionEntry}\n\n---\n\n${existingRow.storedVersionNotes}`
    : newVersionEntry;

  await notion.pages.update({
    page_id: existingRow.notionPageId,
    properties: {
      ...buildProperties(term),
      "Version Notes": { rich_text: toRichText(updatedVersionNotes) },
    },
  });

  if (bodyData?.blocks?.length > 0) {
    await replacePageBody(existingRow.notionPageId, bodyData.blocks);
  }
}

// ─── Main sync logic ────────────────────────────────────────────────────────

async function sync() {
  console.log("=== Glossary Sync Start ===\n");

  // Validate environment
  if (!NOTION_GLOSSARY_KEY || !SQUARESPACE_URL || !NOTION_DATABASE_ID) {
    throw new Error(
      "Missing required environment variables: NOTION_GLOSSARY_KEY, SQUARESPACE_URL, NOTION_DATABASE_ID"
    );
  }

  // 1. Get all terms from Squarespace
  const squarespaceTerms = await fetchAllSquarespaceTerms();

  // 2. Get all existing rows from Notion (keyed by URL)
  const notionRows = await fetchNotionRows();

  // 3. Process each term
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const term of squarespaceTerms) {
    const existing = notionRows.get(term.url);

    if (!existing) {
      // ── NEW TERM ──────────────────────────────────────────────────────────
      // Fetch full body since we have nothing in Notion yet
      await sleep(DELAY_MS);
      const bodyData = await fetchFullBody(term.slug);
      await createNotionRow(term, bodyData);
      created++;

    } else if (existing.storedExcerpt !== term.excerpt) {
      // ── CHANGED TERM ──────────────────────────────────────────────────────
      // Excerpt differs from what's in Notion — fetch full body and update
      await sleep(DELAY_MS);
      const bodyData = await fetchFullBody(term.slug);
      await updateNotionRow(term, bodyData, existing);
      updated++;

    } else {
      // ── UNCHANGED ─────────────────────────────────────────────────────────
      skipped++;
    }

    // Small delay between Notion writes to stay within rate limits
    await sleep(DELAY_MS);
  }

  console.log("\n=== Sync Complete ===");
  console.log(`  ✚ Created:  ${created}`);
  console.log(`  ✎ Updated:  ${updated}`);
  console.log(`  ✓ Skipped:  ${skipped}`);
  console.log(`  Total:      ${squarespaceTerms.length}`);
}

// Run
sync().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});