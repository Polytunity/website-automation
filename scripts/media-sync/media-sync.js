/**
 * sync.js
 * Squarespace Media & Uptake Page to Notion Database sync script
 *
 * What this does:
 *  1. Fetches all media and uptake terms from Squarespace's JSON feed (paginated)
 *  2. Fetches the current state of the Notion database
 *  3. For each Squarespace term:
 *     a. If it's NEW: create a new Notion row
 *     b. If it's CHANGED (excerpt differs): fetch full body, strip HTML,
 *        back up old definition to Version Notes, then update the row
 *     c. If UNCHANGED: skip it entirely
 *
 * Environment variables (set as GitHub Actions secrets):
 *   NOTION_MEDIA_KEY          – Notion integration secret for media & uptake database
 *   SQUARESPACE_URL     – base URL, e.g. https://yuen-yuen-ang.squarespace.com (no trailing slash)
 *   NOTION_MEDIA_DB_ID  – your Notion database ID
 */

const { Client } = require("@notionhq/client"); // Notion SDK

// ─── Config ────────────────────────────────────────────────────────────────

const NOTION_MEDIA_KEY = process.env.NOTION_MEDIA_KEY;
const SQUARESPACE_URL = process.env.SQUARESPACE_URL;
const NOTION_MEDIA_DB_ID = process.env.NOTION_MEDIA_DB_ID;

const BLOG_SLUG = "media-uptake-index"; // the Squarespace blog slug
const DELAY_MS = 250; // delay between per-term fetches (be polite to Squarespace)

const notion = new Client({ auth: NOTION_MEDIA_KEY });

const {
  decodeEntities, stripHtml, toRichText,
  parseInlineHtml, htmlToNotionBlocks, makeReplacePageBody
} = require("../shared/notion-helpers");

// ─── Utilities ─────────────────────────────────────────────────────────────

/** Pause execution for a given number of milliseconds */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const replacePageBody = makeReplacePageBody(notion, sleep);

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
      database_id: NOTION_MEDIA_DB_ID,
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
 * Build the Notion properties object for a media & uptake item.
 * This is shared between create and update operations.
 */
function buildProperties(item) {
  return {
    "Title": { title: [{ type: "text", text: { content: item.title } }] },
    "Excerpt": { rich_text: toRichText(item.excerpt) },
    "Categories": { multi_select: item.categories.map((cat) => ({ name: cat })) },
    "Squarespace URL": { url: item.url },
    "Last Synced": { date: { start: new Date().toISOString() } },
  };
}

/**
 * Create a brand new Notion row for a media & uptake item we've never seen before.
 */
async function createNotionRow(item, bodyData) {
  console.log(`  ✚ Creating: "${item.title}"`);
  const page = await notion.pages.create({
    parent: { database_id: NOTION_MEDIA_DB_ID },
    properties: buildProperties(item),
    children: bodyData?.blocks?.slice(0, 100) || [],
  });
  if (bodyData?.blocks?.length > 100) {
    await replacePageBody(page.id, bodyData.blocks);
  }
}

/**
 * Update an existing Notion row when a media & uptake item's content has changed.
 * Before overwriting the definition, we append the OLD definition
 * to Version Notes with a timestamp — this is the revert/history capability.
 */
async function updateNotionRow(item, bodyData, existingRow) {
  console.log(`  ✎ Updating: "${item.title}"`);
  const timestamp = new Date().toISOString().split("T")[0];
  const newVersionEntry = `[${timestamp}] ${existingRow.storedExcerpt}`;
  const updatedVersionNotes = existingRow.storedVersionNotes
    ? `${newVersionEntry}\n\n---\n\n${existingRow.storedVersionNotes}`
    : newVersionEntry;

  await notion.pages.update({
    page_id: existingRow.notionPageId,
    properties: {
      ...buildProperties(item),
      "Version Notes": { rich_text: toRichText(updatedVersionNotes) },
    },
  });

  if (bodyData?.blocks?.length > 0) {
    await replacePageBody(existingRow.notionPageId, bodyData.blocks);
  }
}

// ─── Main sync logic ────────────────────────────────────────────────────────

async function sync() {
  console.log("=== Media & Uptake Sync Start ===\n");

  // Validate environment
  if (!NOTION_MEDIA_KEY || !SQUARESPACE_URL || !NOTION_MEDIA_DB_ID) {
    throw new Error(
      "Missing required environment variables: NOTION_MEDIA_KEY, SQUARESPACE_URL, NOTION_MEDIA_DB_ID"
    );
  }

  // 1. Get all media & uptake items from Squarespace
  const squarespaceTerms = await fetchAllSquarespaceTerms();

  // 2. Get all existing rows from Notion (keyed by URL)
  const notionRows = await fetchNotionRows();

  // 3. Process each media & uptake item
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of squarespaceTerms) {
    const existing = notionRows.get(item.url);

    if (!existing) {
      // ── NEW ITEM ──────────────────────────────────────────────────────────
      // Fetch full body since we have nothing in Notion yet
      await sleep(DELAY_MS);
      const bodyData = await fetchFullBody(item.slug);
      await createNotionRow(item, bodyData);
      created++;

    } else if (existing.storedExcerpt !== item.excerpt) {
      // ── CHANGED ITEM ──────────────────────────────────────────────────────
      // Excerpt differs from what's in Notion — fetch full body and update
      await sleep(DELAY_MS);
      const bodyData = await fetchFullBody(item.slug);
      await updateNotionRow(item, bodyData, existing);
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