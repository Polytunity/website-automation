# Website Automation

Automated scripts for managing Yuen Yuen Ang's research team database and website.

---

## Overview

| Script | What it does | Schedule |
|--------|-------------|----------|
| `scripts/glossary-sync/sync.js` | Syncs Squarespace glossary → Notion database | Daily |
| `scripts/website-backup/backup.js` | Backs up website pages + images → Notion | Every 2 months |

---

## Architecture

```
Squarespace (glossary blog)
    ↓  RSS/JSON feed — read by sync.js daily
Notion Glossary Database
    ↑  Team edits happen here for version history + AI access

Squarespace (website pages)
    ↓  ?format=json + sitemap — read by backup.js bimonthly
Notion Website Backup Database
    ↑  Full text + images stored per page

Notion Sources Database
    ↓  Read by Vercel middleware API
Squarespace Sources Page
    ↑  Code block fetches and renders at load time
```

---

## Scripts

### `scripts/glossary-sync/sync.js`

Fetches all glossary terms from the Squarespace blog at `/glossary-index`, compares against Notion, and upserts changes. For changed terms, the old excerpt is appended to Version Notes before overwriting — this provides the revert/history capability.

**Change detection:** uses the excerpt field as a cheap diff. Only fetches the full post body (second HTTP request per term) when a change is detected.

**Notion database:** Glossary DB  
**Workflow:** `.github/workflows/sync-glossary.yml`

---

### `scripts/website-backup/backup.js`

Fetches the sitemap, filters to the ~16 top-level pages (excludes blog index entries already tracked in Notion), fetches full page content via `?format=json`, and writes text + images to Notion. Each website page becomes one Notion page in the backup database.

**Image handling:** image URLs are extracted from the sitemap's `<image:loc>` tags and stored as embedded image blocks in Notion. No separate image download needed.

**Pages backed up:**
- `/home`, `/awards`, `/contact`, `/teach`, `/inet-lecture`
- `/polytunity`, `/aim`, `/adaptive-pe`, `/chinainsights`, `/paradigm`
- `/how-china-escaped-the-poverty-trap`, `/china-gilded-age`
- `/glossary`, `/sources`, `/directed-improvisation-with-ai`, `/media-uptake`

**Notion database:** Website Backup DB  
**Workflow:** `.github/workflows/backup-website.yml`

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` for local testing:
```bash
cp .env.example .env
```

Fill in your values. For GitHub Actions, add each variable as a repository secret under **Settings → Secrets and variables → Actions**.

### 3. Run locally
```bash
# Glossary sync
node scripts/glossary-sync/sync.js

# Website backup
node scripts/website-backup/backup.js
```

### 4. Trigger manually via GitHub Actions
Go to **Actions → [workflow name] → Run workflow** to trigger either script without waiting for the schedule.

---

## Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `NOTION_GLOSSARY_KEY` | sync.js | Notion integration secret for glossary database |
| `NOTION_DATABASE_ID` | sync.js | Notion glossary database ID |
| `NOTION_BACKUP_KEY` | backup.js | Notion integration secret for backup database |
| `NOTION_BACKUP_DB_ID` | backup.js | Notion website backup database ID |
| `SQUARESPACE_URL` | both | Base URL, e.g. `https://www.yuenyuenang.org` |

---

## Notion Database Schemas

### Glossary Database
| Field | Type | Notes |
|-------|------|-------|
| Term | Title | Glossary term name |
| Excerpt | Rich Text | Short definition — used for change detection |
| Categories | Multi-select | Tags from Squarespace |
| Squarespace URL | URL | Unique key for matching rows |
| Last Synced | Date | Timestamp of last sync |
| Version Notes | Rich Text | Previous excerpts prepended on each change |

### Website Backup Database
| Field | Type | Notes |
|-------|------|-------|
| Page Title | Title | Derived from URL path |
| Page URL | URL | Full Squarespace URL |
| Last Backed Up | Date | Timestamp of last backup run |

---

## File Structure

```
website-automation/
├── .github/
│   └── workflows/
│       ├── sync-glossary.yml       # Daily glossary sync
│       └── backup-website.yml      # Bimonthly website backup
├── scripts/
│   ├── glossary-sync/
│   │   └── sync.js
│   └── website-backup/
│       └── backup.js
├── .env.example
├── package.json
└── README.md
```

---

## Adding a New Script

1. Create a folder under `scripts/your-script-name/`
2. Add your script as `index.js` or a descriptive name
3. Add a workflow file under `.github/workflows/`
4. Document the new environment variables in `.env.example` and this README