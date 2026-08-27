/**
 * api/graph.js
 * Vercel serverless function — serves glossary graph data to the
 * Squarespace code block.
 *
 * Deploy to Vercel alongside your existing sources middleware.
 * Endpoint: GET /api/graph
 *
 * Returns: { nodes: [...], edges: [...] }
 *
 * Environment variable (set in Vercel dashboard):
 *   NOTION_GLOSSARY_KEY  — Notion integration secret
 *   NOTION_DATABASE_ID   — Glossary database ID
 */

const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_GLOSSARY_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

function richText(prop) {
  return prop?.rich_text?.map((r) => r.plain_text).join("") ?? "";
}

async function fetchGraph() {
  const pages = [];
  let cursor = undefined;

  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  const nodes = [];
  const edges = [];

  for (const page of pages) {
    const props = page.properties;
    const id = page.id;
    const title = props["Term"]?.title?.map((t) => t.plain_text).join("") ?? "";
    if (!title) continue;

    nodes.push({
      id,
      title,
      excerpt: richText(props["Excerpt"]),
      ideaLevel: props["Idea Level"]?.select?.name ?? "Concept",
      categories: props["Categories"]?.multi_select?.map((c) => c.name) ?? [],
      squarespaceUrl: props["Squarespace URL"]?.url ?? null,
    });

    const derivedFrom = props["Derived From (Genealogy)"]?.relation ?? [];
    for (const rel of derivedFrom) {
      edges.push({ source: rel.id, target: id, relationType: "derived_from" });
    }

    const relatedTerms = props["Related Terms (Concept Constellation)"]?.relation ?? [];
    for (const rel of relatedTerms) {
      if (id < rel.id) {
        edges.push({ source: id, target: rel.id, relationType: "related_term" });
      }
    }
  }

  return { nodes, edges };
}

// Cache the graph for 1 hour to avoid hammering Notion on every page load
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in ms

module.exports = async (req, res) => {
  // CORS — allow Squarespace to fetch this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const now = Date.now();
    if (!cache || now - cacheTime > CACHE_TTL) {
      console.log("Cache miss — fetching fresh graph from Notion...");
      cache = await fetchGraph();
      cacheTime = now;
    }
    return res.status(200).json(cache);
  } catch (err) {
    console.error("Graph API error:", err);
    return res.status(500).json({ error: "Failed to fetch graph data." });
  }
};
