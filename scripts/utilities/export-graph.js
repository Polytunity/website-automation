/**
 * export-graph.js
 * One-off utility: exports the Notion Glossary database as a
 * machine-readable graph (nodes.json + edges.json).
 *
 * Run from repo root:
 *   node scripts/utilities/export-graph.js
 *
 * Output files (written to repo root):
 *   nodes.json  — one object per glossary term
 *   edges.json  — one object per relation between terms
 */

require("dotenv").config();
const { Client } = require("@notionhq/client");
const fs = require("fs");
const path = require("path");

const NOTION_API_KEY = process.env.NOTION_GLOSSARY_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const DELAY_MS = 250;

const notion = new Client({ auth: NOTION_API_KEY });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract plain text from a Notion rich_text array */
function richText(prop) {
  return prop?.rich_text?.map((r) => r.plain_text).join("") ?? "";
}

async function exportGraph() {
  console.log("=== Export Glossary Graph ===\n");

  if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    throw new Error("Missing NOTION_GLOSSARY_KEY or NOTION_DATABASE_ID.");
  }

  // ── 1. Fetch all pages ───────────────────────────────────────────────────
  console.log("Fetching all glossary rows from Notion...");
  const pages = [];
  let cursor = undefined;

  do {
    const res = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  console.log(`Fetched ${pages.length} rows.\n`);

  // ── 2. Build nodes ───────────────────────────────────────────────────────
  const nodes = [];
  const edges = [];

  for (const page of pages) {
    const props = page.properties;

    const id = page.id;
    const title = props["Term"]?.title?.map((t) => t.plain_text).join("") ?? "";
    const excerpt = richText(props["Excerpt"]);
    const ideaLevel = props["Idea Level"]?.select?.name ?? "Concept";
    const categories = props["Categories"]?.multi_select?.map((c) => c.name) ?? [];
    const squarespaceUrl = props["Squarespace URL"]?.url ?? null;
    const lastSynced = props["Last Synced"]?.date?.start ?? null;

    if (!title) continue;

    nodes.push({
      id,
      title,
      excerpt,
      ideaLevel,
      categories,
      squarespaceUrl,
      lastSynced,
    });

    // ── 3. Build edges from relation fields ────────────────────────────────

    // Derived From (Genealogy) edges
    const derivedFrom = props["Derived From (Genealogy)"]?.relation ?? [];
    for (const rel of derivedFrom) {
      edges.push({
        source: rel.id,   // the parent term
        target: id,       // this term derives from it
        relationType: "derived_from",
      });
    }

    // Related Terms (Concept Constellation) edges
    // Use a canonical direction: only add edge if source id < target id
    // to avoid duplicate bidirectional edges
    const relatedTerms = props["Related Terms (Concept Constellation)"]?.relation ?? [];
    for (const rel of relatedTerms) {
      if (id < rel.id) {
        edges.push({
          source: id,
          target: rel.id,
          relationType: "related_term",
        });
      }
    }

    await sleep(DELAY_MS);
  }

  // ── 4. Write output files to repo root ──────────────────────────────────
  const repoRoot = path.join(__dirname, "../../");
  fs.writeFileSync(path.join(repoRoot, "nodes.json"), JSON.stringify(nodes, null, 2));
  fs.writeFileSync(path.join(repoRoot, "edges.json"), JSON.stringify(edges, null, 2));

  console.log(`✓ nodes.json — ${nodes.length} nodes`);
  console.log(`✓ edges.json — ${edges.length} edges`);
  console.log("\nDone. Commit these files.");
}

exportGraph().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
