/**
 * populate-relations.js
 * One-off utility script to populate the "Derived From (Genealogy)" and
 * "Related Terms (Concept Constellation)" relation fields in the Notion
 * Glossary database from the glossary_graph_columns.csv file.
 *
 * Run once locally:
 *   node scripts/utilities/populate-relations.js
 *
 * Requirements:
 *   - glossary_graph_columns.csv must be in the repo root
 *   - NOTION_GLOSSARY_KEY and NOTION_DATABASE_ID in your .env file
 */

require("dotenv").config();
const { Client } = require("@notionhq/client");
const fs = require("fs");
const path = require("path");

// ─── Config ────────────────────────────────────────────────────────────────

const NOTION_API_KEY = process.env.NOTION_GLOSSARY_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const CSV_PATH = path.join(__dirname, "../../glossary_graph_columns.csv");
const DELAY_MS = 300;

const notion = new Client({ auth: NOTION_API_KEY });

// ─── Utilities ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize a term name for fuzzy matching.
 * Lowercases, strips punctuation and extra whitespace so that
 * "Normatively Weak, Functionally Strong" matches
 * "Normatively Weak Functionally Strong" etc.
 */
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the CSV manually — avoids needing a csv-parse dependency.
 * Handles quoted fields containing commas.
 */
function parseCSV(content) {
  const lines = content.trim().split("\n");
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => (row[h.trim()] = (values[i] || "").trim()));
    return row;
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// ─── Notion fetching ────────────────────────────────────────────────────────

/**
 * Fetch all rows from the Glossary database.
 * Returns two maps:
 *   - byId:   pageId → { title, pageId }
 *   - byNorm: normalized(title) → pageId
 */
async function fetchAllRows() {
  console.log("Fetching all rows from Notion Glossary database...");

  const byId = new Map();
  const byNorm = new Map();
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      const titleProp = page.properties["Term"];
      const title =
        titleProp?.title?.map((t) => t.plain_text).join("") || "";

      if (!title) continue;

      byId.set(page.id, { title, pageId: page.id });
      byNorm.set(normalize(title), page.id);
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(`Found ${byId.size} rows in Notion.\n`);
  return { byId, byNorm };
}

// ─── Term resolution ────────────────────────────────────────────────────────

/**
 * Resolve a list of term name strings to Notion page IDs.
 * Uses normalized matching to handle minor punctuation differences.
 * Logs a warning for any term that can't be matched.
 */
function resolveTerms(termNames, byNorm, sourceTermName) {
  const pageIds = [];
  const unmatched = [];

  for (const name of termNames) {
    const trimmed = name.trim();
    if (!trimmed) continue;

    // Strip parenthetical notes like "(contrast)" that appear in some entries
    const cleaned = trimmed
      .replace(/\s*\(contrast\)/gi, "")
      .replace(/\s*\(contrast with\)/gi, "")
      .trim();

    const key = normalize(cleaned);
    const pageId = byNorm.get(key);

    if (pageId) {
      pageIds.push(pageId);
    } else {
      // Try partial match — useful for truncated names in CSV
      let found = false;
      for (const [normKey, id] of byNorm.entries()) {
        if (normKey.includes(key) || key.includes(normKey)) {
          pageIds.push(id);
          found = true;
          break;
        }
      }
      if (!found) {
        unmatched.push(trimmed);
      }
    }
  }

  if (unmatched.length > 0) {
    console.warn(
      `  ⚠ [${sourceTermName}] Could not match: ${unmatched.join(", ")}`
    );
  }

  return pageIds;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function populate() {
  console.log("=== Populate Glossary Relations ===\n");

  if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    throw new Error(
      "Missing NOTION_GLOSSARY_KEY or NOTION_DATABASE_ID in environment."
    );
  }

  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`CSV not found at: ${CSV_PATH}`);
  }

  // 1. Parse CSV
  const csvContent = fs.readFileSync(CSV_PATH, "utf-8");
  const rows = parseCSV(csvContent);
  console.log(`Parsed ${rows.length} rows from CSV.\n`);

  // 2. Fetch all Notion rows and build name → ID map
  const { byNorm } = await fetchAllRows();

  // 3. Process each CSV row
  let success = 0;
  let failed = 0;

  for (const row of rows) {
    const termName = row["Term"]?.trim();
    if (!termName) continue;

    // Look up this term's Notion page ID
    const termPageId = byNorm.get(normalize(termName));
    if (!termPageId) {
      console.warn(`⚠ Term not found in Notion: "${termName}" — skipping.`);
      failed++;
      continue;
    }

    console.log(`Processing: "${termName}"`);

    // Parse semicolon-separated relation lists
    const derivedFromNames = (row["Derived From (Genealogy)"] || "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    const relatedTermNames = (
      row["Related Terms (Concept Constellation)"] || ""
    )
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    // Resolve names to Notion page IDs
    const derivedFromIds = resolveTerms(derivedFromNames, byNorm, termName);
    const relatedTermIds = resolveTerms(relatedTermNames, byNorm, termName);

    // Build the update payload
    const properties = {};

    if (derivedFromIds.length > 0) {
      properties["Derived From (Genealogy)"] = {
        relation: derivedFromIds.map((id) => ({ id })),
      };
    }

    if (relatedTermIds.length > 0) {
      properties["Related Terms (Concept Constellation)"] = {
        relation: relatedTermIds.map((id) => ({ id })),
      };
    }

    if (Object.keys(properties).length === 0) {
      console.log(`  (no relations to set — skipping API call)`);
      continue;
    }

    // Update the Notion page
    try {
      await notion.pages.update({ page_id: termPageId, properties });
      console.log(
        `  ✓ Set ${derivedFromIds.length} "Derived From" + ${relatedTermIds.length} "Related Terms"`
      );
      success++;
    } catch (err) {
      console.error(`  ✗ Failed to update "${termName}": ${err.message}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log("\n=== Done ===");
  console.log(`  ✓ Success: ${success}`);
  console.log(`  ✗ Failed:  ${failed}`);
  console.log(
    "\nCheck warnings above for any terms that couldn't be matched."
  );
  console.log(
    "Those will need to be set manually in Notion."
  );
}

populate().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});