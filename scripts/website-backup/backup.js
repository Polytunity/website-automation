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

const { htmlToNotionBlocks, toRichText, makeReplacePageBody } = require("../shared/notion-helpers");

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
  "/awards-index",
  "/book-review-index",
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
  "/directed-improvisation-with-ai",
  "/media-uptake",
]);

// ─── Utilities ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const replacePageBody = makeReplacePageBody(notion, sleep);

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
  const res = await fetch(fullUrl, {
    headers: {
      // Fetch as a browser so Squarespace returns full HTML
      "User-Agent": "Mozilla/5.0 (compatible; backup-bot/1.0)",
      "Accept": "text/html",
    },
  });

  if (!res.ok) {
    console.warn(`  ⚠ Could not fetch content for ${fullUrl}: ${res.status}`);
    return "";
  }

  const html = await res.text();

  // Extract text from the main content area only — skip nav, footer, scripts
  // Squarespace wraps page content in <main> or <article> or .sqs-layout
  let content = html;

  // Try to isolate main content block
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (mainMatch) content = mainMatch[1];
  else if (articleMatch) content = articleMatch[1];

  // Remove script/style/nav/footer but KEEP structural HTML tags
  // so htmlToNotionBlocks can parse headings, paragraphs, lists etc.
  content = content
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "");

  return content; // return HTML, not stripped text
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
function buildPageBlocks(contentHtml, imageUrls) {
  const blocks = [];

  // ── Text content as formatted blocks ─────────────────────────────────────
  blocks.push({
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: "Page Content" } }] },
  });

  const contentBlocks = htmlToNotionBlocks(contentHtml);
  if (contentBlocks.length > 0) {
    blocks.push(...contentBlocks);
  } else {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: "(No text content extracted)" } }] },
    });
  }

  // ── Images ────────────────────────────────────────────────────────────────
  /*
  if (imageUrls.length > 0) {
    blocks.push({ object: "block", type: "divider", divider: {} });
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: `Images (${imageUrls.length})` } }] },
    });
    for (const url of imageUrls) {
      blocks.push({
        object: "block",
        type: "image",
        image: { type: "external", external: { url } },
      });
    }
  }
  */

  return blocks;
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
    const contentHtml = await fetchPageContent(fullUrl);

    // Derive a readable title from the path
    const title = path
      .replace("/", "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()) || "Home";

    // Build Notion blocks
    const blocks = buildPageBlocks(contentHtml, images);

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