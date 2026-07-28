/**
 * backup.js
 * Squarespace Website → Notion Backup Script
 *
 * What this does:
 *  1. Fetches the sitemap from Squarespace
 *  2. Filters to only top-level pages (excludes blog index entries like
 *     glossary-index/*, awards-index/*, etc. which are already in Notion)
 *  3. For each page, fetches full text content via ?format=json
 *  4. Collects image URLs from the sitemap (no extra fetches needed)
 *  5. Creates or updates a Notion page for each website page, with:
 *     - Text content written as paragraph blocks in the page body
 *     - Image URLs stored as bookmark blocks
 *     - Last backed up timestamp and source URL as properties
 *
 * Schedule: runs every two months via GitHub Actions (see backup-website.yml)
 *
 * Environment variables (GitHub Actions secrets):
 *   NOTION_BACKUP_KEY      - Notion integration secret for backup database
 *   NOTION_BACKUP_DB_ID    - Notion database ID for the website backup
 *   SQUARESPACE_URL        - e.g. https://www.yuenyuenang.org (no trailing slash)
 */

const { Client } = require("@notionhq/client");

// ─── Config ────────────────────────────────────────────────────────────────

const NOTION_BACKUP_KEY = process.env.NOTION_BACKUP_KEY;
const NOTION_BACKUP_DB_ID = process.env.NOTION_BACKUP_DB_ID;
const SQUARESPACE_URL = process.env.SQUARESPACE_URL;

const DELAY_MS = 300;

const notion = new Client({ auth: NOTION_BACKUP_KEY });

// ─── Pages to back up ──────────────────────────────────────────────────────

/**
 * These are the top-level pages we want to back up.
 * Blog index entries (glossary-index/*, awards-index/*, etc.) are excluded
 * because they are already tracked in dedicated Notion databases.
 *
 * Add or remove slugs here if the site structure changes.
 */
const PAGES_TO_BACKUP = new Set([
  "/home",
  "/awards",
  "/contact",
  "/teach",
  "/inet-lecture",
  "/polytunity",
  "/aim",
  "/adaptive-pe",
  "/chinainsights",
  "/paradigm",
  "/how-china-escaped-the-poverty-trap",
  "/china-gilded-age",
  "/glossary",
  "/sources",
  "/directed-improvisation-with-ai",
  "/media-uptake",
]);

// ─── Utilities ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decode HTML entities to plain text */
function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&hellip;/g, "…");
}

/** Strip HTML tags and collapse whitespace to plain text */
function stripHtml(html) {
  if (!html) return "";
  return decodeEntities(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a long plain-text string into Notion rich_text chunks.
 * Notion enforces a 2000-character limit per rich_text element.
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

// ─── Sitemap parsing ────────────────────────────────────────────────────────

/**
 * Fetch and parse the Squarespace sitemap.
 * Returns a Map: path → [imageUrl, imageUrl, ...]
 *
 * We extract image URLs directly from the sitemap's <image:loc> tags —
 * this avoids an extra fetch per page just to find images.
 */
async function fetchSitemap() {
  const url = `${SQUARESPACE_URL}/sitemap.xml`;
  console.log(`Fetching sitemap from ${url}...`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status}`);
  const xml = await res.text();

  // Map of path → array of image URLs
  const sitemapData = new Map();

  // Extract each <url> block
  const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];

  for (const block of urlBlocks) {
    // Get the page location
    const locMatch = block.match(/<loc>(.*?)<\/loc>/);
    if (!locMatch) continue;

    const fullUrl = locMatch[1].trim();
    const path = fullUrl.replace(SQUARESPACE_URL, "").replace("https://www.yuenyuenang.org", "");

    // Only keep pages we want to back up
    if (!PAGES_TO_BACKUP.has(path)) continue;

    // Extract all image URLs from this block
    const imageMatches = block.match(/<image:loc>(.*?)<\/image:loc>/g) || [];
    const images = imageMatches.map((m) =>
      m.replace(/<image:loc>/, "").replace(/<\/image:loc>/, "").trim()
    );

    sitemapData.set(path, { fullUrl, images });
  }

  console.log(`Found ${sitemapData.size} pages to back up in sitemap.`);
  return sitemapData;
}

// ─── Squarespace page fetching ──────────────────────────────────────────────

/**
 * Fetch the full text content of a single Squarespace page via ?format=json.
 * Squarespace returns structured content blocks — we extract all text from them.
 *
 * Returns a plain-text string of all content on the page.
 */
async function fetchPageContent(fullUrl) {
  const url = `${fullUrl}?format=json`;
  const res = await fetch(url);

  if (!res.ok) {
    console.warn(`  ⚠ Could not fetch content for ${fullUrl}: ${res.status}`);
    return "";
  }

  const data = await res.json();
  const textParts = [];

  // Page title
  if (data.collection?.title) textParts.push(data.collection.title);
  if (data.item?.title) textParts.push(data.item.title);

  // Walk through content layout blocks and extract text
  const layout = data.layout || data.page?.layout || [];

  function extractFromBlocks(blocks) {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      // Text/HTML blocks
      if (block.type === "text" && block.value) {
        textParts.push(stripHtml(block.value));
      }
      // Image alt text
      if (block.type === "image" && block.value?.altText) {
        textParts.push(`[Image: ${block.value.altText}]`);
      }
      // Video blocks
      if (block.type === "video" && block.value?.title) {
        textParts.push(`[Video: ${block.value.title}]`);
      }
      // Recurse into nested rows/columns
      if (block.rows) extractFromBlocks(block.rows);
      if (block.columns) extractFromBlocks(block.columns);
      if (block.blocks) extractFromBlocks(block.blocks);
    }
  }

  extractFromBlocks(layout);

  // Also try the simpler body field if layout parsing yields nothing
  if (textParts.length === 0 && data.item?.body) {
    textParts.push(stripHtml(data.item.body));
  }

  return textParts.filter(Boolean).join("\n\n");
}

// ─── Notion fetching ────────────────────────────────────────────────────────

/**
 * Fetch all existing backup rows from Notion, keyed by page path.
 * Returns a Map: path → { notionPageId }
 */
async function fetchExistingBackups() {
  console.log("Fetching existing backups from Notion...");

  const rows = new Map();
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: NOTION_BACKUP_DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      const urlProp = page.properties["Page URL"]?.url;
      if (!urlProp) continue;

      // Extract path from stored URL for keying
      const path = urlProp.replace(SQUARESPACE_URL, "").replace("https://www.yuenyuenang.org", "");
      rows.set(path, { notionPageId: page.id });
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(`Found ${rows.size} existing backups in Notion.`);
  return rows;
}

// ─── Notion writing ─────────────────────────────────────────────────────────

/** Row-level properties for the backup database */
function buildProperties(title, fullUrl) {
  return {
    "Page Title": {
      title: [{ type: "text", text: { content: title } }],
    },
    "Page URL": {
      url: fullUrl,
    },
    "Last Backed Up": {
      date: { start: new Date().toISOString() },
    },
  };
}

/**
 * Build Notion blocks from page content text and image URLs.
 *
 * Structure:
 *   - A heading block labelling the content section
 *   - Paragraph blocks for the text content (chunked to 2000 chars)
 *   - A divider
 *   - A heading block labelling the images section
 *   - Bookmark blocks for each image URL
 */
function buildPageBlocks(contentText, imageUrls) {
  const blocks = [];

  // ── Text content ──────────────────────────────────────────────────────────
  blocks.push({
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [{ type: "text", text: { content: "Page Content" } }],
    },
  });

  if (contentText) {
    // Split content into 2000-char paragraph chunks
    const CHUNK_SIZE = 1900;
    for (let i = 0; i < contentText.length; i += CHUNK_SIZE) {
      const chunk = contentText.slice(i, i + CHUNK_SIZE);
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: toRichText(chunk) },
      });
    }
  } else {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: "(No text content extracted)" } }],
      },
    });
  }

  // ── Images ────────────────────────────────────────────────────────────────
  if (imageUrls.length > 0) {
    blocks.push({ object: "block", type: "divider", divider: {} });
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: `Images (${imageUrls.length})` } }],
      },
    });

    for (const url of imageUrls) {
      blocks.push({
        object: "block",
        type: "image",
        image: {
          type: "external",
          external: { url },
        },
      });
    }
  }

  return blocks;
}

/**
 * Replace all blocks on an existing Notion page.
 * Deletes current blocks first, then appends new ones in batches of 100.
 */
async function replacePageBody(pageId, blocks) {
  // Fetch and delete existing blocks
  let existingBlocks = [];
  let cursor = undefined;
  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
    });
    existingBlocks = existingBlocks.concat(res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  for (const block of existingBlocks) {
    await notion.blocks.delete({ block_id: block.id });
    await sleep(50);
  }

  // Append new blocks in batches of 100
  const BATCH_SIZE = 100;
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + BATCH_SIZE),
    });
    await sleep(100);
  }
}

async function createBackupPage(title, fullUrl, blocks) {
  console.log(`  ✚ Creating backup: "${title}"`);

  const page = await notion.pages.create({
    parent: { database_id: NOTION_BACKUP_DB_ID },
    properties: buildProperties(title, fullUrl),
    children: blocks.slice(0, 100),
  });

  if (blocks.length > 100) {
    await replacePageBody(page.id, blocks);
  }
}

async function updateBackupPage(notionPageId, title, fullUrl, blocks) {
  console.log(`  ✎ Updating backup: "${title}"`);

  await notion.pages.update({
    page_id: notionPageId,
    properties: buildProperties(title, fullUrl),
  });

  await replacePageBody(notionPageId, blocks);
}

// ─── Main backup logic ──────────────────────────────────────────────────────

async function backup() {
  console.log("=== Website Backup Start ===\n");

  if (!NOTION_BACKUP_KEY || !NOTION_BACKUP_DB_ID || !SQUARESPACE_URL) {
    throw new Error(
      "Missing required environment variables: NOTION_BACKUP_KEY, NOTION_BACKUP_DB_ID, SQUARESPACE_URL"
    );
  }

  // 1. Parse sitemap to get pages + image URLs
  const sitemapData = await fetchSitemap();

  // 2. Get existing Notion backup rows
  const existingBackups = await fetchExistingBackups();

  let created = 0;
  let updated = 0;

  // 3. Process each page
  for (const [path, { fullUrl, images }] of sitemapData) {
    console.log(`\nProcessing: ${path}`);

    // Fetch page text content
    await sleep(DELAY_MS);
    const contentText = await fetchPageContent(fullUrl);

    // Derive a readable title from the path
    const title = path
      .replace("/", "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()) || "Home";

    // Build Notion blocks
    const blocks = buildPageBlocks(contentText, images);

    // Create or update
    const existing = existingBackups.get(path);
    if (!existing) {
      await createBackupPage(title, fullUrl, blocks);
      created++;
    } else {
      await updateBackupPage(existing.notionPageId, title, fullUrl, blocks);
      updated++;
    }

    await sleep(DELAY_MS);
  }

  console.log("\n=== Backup Complete ===");
  console.log(`  ✚ Created: ${created}`);
  console.log(`  ✎ Updated: ${updated}`);
  console.log(`  Total:     ${created + updated}`);
}

// Run
backup().catch((err) => {
  console.error("Backup failed:", err);
  process.exit(1);
});