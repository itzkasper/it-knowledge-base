# City of Homestead — IT Knowledge Base

A small, modern internal site that hosts SOPs and IT documentation, with a PRTG
dashboard on the front page showing NetFlow and SNMP data.

Built to run on **Windows Server 2019 / IIS** with **Windows Authentication**.

---

## What it does

**Dashboard** (`/`) — live from your PRTG core server:

- Sensor counts by state, with the monitored total as the headline figure
- Traffic by channel for any NetFlow / IPFIX / sFlow / jFlow sensor, over 1h to 7d
- Top talkers, read from the sensor's PRTG toplist
- SNMP sensors grouped by device, worst first
- Active alarms, with paused sensors excluded

**Knowledge base** (`/docs.html`):

- Markdown documents with YAML front matter, organised by category
- Full-text search across titles, headings, tags and body text
- Auto-generated table of contents, callouts, tables, task lists, code blocks
- Deep-linkable headings; prints cleanly

Light and dark themes follow the OS and can be toggled per person.

---

## Why there is a backend

PRTG's API authenticates with an API token or a `passhash` in the query string.
A browser calling PRTG directly would need that credential in client-side
JavaScript, where anyone who can open the page can read it — and it would hit
CORS restrictions anyway.

So a thin ASP.NET Core app sits in front: it holds the credential server-side
and exposes only a handful of read-only, purpose-built endpoints. There is
deliberately **no generic passthrough**, so the stored credential can't be used
to reach arbitrary PRTG endpoints from the browser.

Everything else is static files — no database, no build step for the frontend,
no npm, no CDN. The markdown renderer and charts are hand-written and
dependency-free, so the site works on an air-gapped network.

---

## Layout

```
it-knowledge-base/
├── src/KnowledgeBase/
│   ├── Program.cs                 host, security headers, static files, auth
│   ├── Endpoints/ApiEndpoints.cs  /api/me and /api/prtg/*
│   ├── Prtg/
│   │   ├── PrtgClient.cs          typed PRTG API client, 15s response cache
│   │   └── PrtgModels.cs          options + DTOs, PRTG status-code mapping
│   ├── appsettings.json           PRTG connection settings
│   ├── web.config                 IIS: Windows Auth, .md MIME type, compression
│   └── wwwroot/
│       ├── index.html             dashboard
│       ├── docs.html              knowledge base
│       ├── assets/css/app.css     design tokens + all styling
│       ├── assets/brand/          logo, favicons (see Branding below)
│       ├── assets/js/
│       │   ├── core.js            theme, API helper, formatting, status pills
│       │   ├── markdown.js        markdown → HTML, no dependencies
│       │   ├── charts.js          inline-SVG line/bar/sparkline charts
│       │   ├── dashboard.js       PRTG front page
│       │   └── docs.js            tree, search, article rendering, routing
│       └── content/               ← your documents live here
│           ├── index.json         generated search index
│           ├── _template.md       starting point for a new document
│           ├── sops/ runbooks/ network/ policies/ reference/
└── tools/
    ├── Build-DocsIndex.ps1        regenerate content/index.json
    ├── Build-Icons.py             regenerate favicon.ico/PNGs (only on rebrand)
    └── Publish-Site.ps1           build + deploy to IIS
```

---

## Quick start

### On the server

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full walkthrough — IIS features,
app pool, Windows Auth, HTTPS, PRTG credentials and a troubleshooting table.

Short version:

1. `Install-WindowsFeature Web-Server, Web-Windows-Auth, …`
2. Install the **.NET 8 Windows Hosting Bundle** (after IIS)
3. Create the site and app pool, enable Windows Auth, disable Anonymous
4. `.\tools\Publish-Site.ps1`
5. Set `Prtg:BaseUrl` and `Prtg:ApiToken` in the deployed `appsettings.json`

### Locally, to try it out

```bash
cd src/KnowledgeBase
dotnet run
```

Then open <http://localhost:5000>. Local runs use
`appsettings.Development.json`, which disables the authentication requirement
(Kestrel has no Windows Auth handler) and accepts self-signed PRTG
certificates. The knowledge base works with no PRTG at all — the dashboard just
shows a banner saying PRTG is unavailable.

---

## Writing documents

Create a `.md` file under `wwwroot/content/<category>/`, starting with front
matter:

```markdown
---
title: Reset a Locked Active Directory Account
category: SOPs
tags: [active-directory, accounts]
updated: 2026-10-14
owner: Service Desk
---

## Purpose

...
```

| Field | Required | Notes |
|-------|----------|-------|
| `title` | recommended | Falls back to the first `# heading`, then the filename |
| `category` | recommended | Groups the sidebar; falls back to the folder name |
| `tags` | no | Weighted in search |
| `updated` | no | Falls back to the file's modified date |
| `owner` | no | Shown in the article header |

Then rebuild the index:

```powershell
.\tools\Build-DocsIndex.ps1

# or, while writing:
.\tools\Build-DocsIndex.ps1 -Watch
```

Files beginning with `_` are skipped, so `_template.md` stays out of the
knowledge base.

### Supported markdown

Headings (with anchor links), **bold**, *italic*, `inline code`, fenced code
blocks with a language tag, nested ordered and unordered lists, task lists,
tables with alignment, blockquotes, horizontal rules, images, and links.

Cross-link documents by slug — the path under `content/` without the extension:

```markdown
See [the SNMP baseline](#/network/snmp-baseline).
```

GitHub-style callouts render as coloured panels:

```markdown
> [!WARNING]
> Verify identity before unlocking any account.
```

`NOTE`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION` are supported.

---

## API

All endpoints are read-only, require an authenticated user, and return JSON.

| Endpoint | Returns |
|----------|---------|
| `GET /api/me` | The signed-in Windows user |
| `GET /api/prtg/health` | Whether PRTG is configured and reachable |
| `GET /api/prtg/summary` | Sensor counts by state, PRTG version |
| `GET /api/prtg/alarms?limit=25` | Sensors in a non-OK state, worst first |
| `GET /api/prtg/netflow` | Flow sensors (NetFlow, IPFIX, sFlow, jFlow) |
| `GET /api/prtg/snmp?limit=12` | SNMP sensors grouped by device |
| `GET /api/prtg/sensors/{id}/history?hours=6&avg=300` | Channel history |
| `GET /api/prtg/sensors/{id}/toplists` | Toplists on a flow sensor |
| `GET /api/prtg/sensors/{id}/toplists/{toplistId}` | Toplist rows |

PRTG failures come back as RFC 7807 problem documents — `503` when PRTG isn't
configured, `502` when it rejects the credential or is unreachable, `504` on
timeout — so the dashboard can show the reason inline instead of going blank.

Responses are cached for `Prtg:CacheSeconds` (default 15) so a room full of open
dashboards doesn't hammer the PRTG core.

---

## Configuration

`appsettings.json`:

| Key | Default | Purpose |
|-----|---------|---------|
| `Prtg:BaseUrl` | — | PRTG core URL, e.g. `https://prtg.contoso.local` |
| `Prtg:ApiToken` | — | Read-only API token (preferred) |
| `Prtg:Username` / `Prtg:PassHash` | — | Used only when no token is set |
| `Prtg:AllowUntrustedCertificate` | `false` | Accept PRTG's self-signed certificate |
| `Prtg:CacheSeconds` | `15` | Response cache lifetime |
| `Prtg:MaxSensors` | `2000` | Row cap on the sensor table query |
| `Prtg:TimeoutSeconds` | `20` | PRTG request timeout |
| `Security:RequireAuthenticatedUser` | `true` | Set `false` only for local dev |

Any value can be supplied as an environment variable instead, which keeps the
token out of the file — `Prtg__ApiToken` maps to `Prtg:ApiToken`.

---

## Security notes

- PRTG credentials stay server-side; the browser only sees `/api/prtg/*` results.
- The PRTG base URL *is* sent to the browser, so the UI can deep-link sensors.
  It carries no credential.
- Error messages never echo the PRTG request URL, because the passhash variant
  carries the credential in the query string.
- Markdown is escaped before rendering, and link targets are scheme-checked —
  `javascript:`, `vbscript:` and non-image `data:` URLs are neutralised.
- A strict Content-Security-Policy is sent; the site loads no third-party code,
  so nothing needs an exception.
- `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and HSTS
  (outside Development) are set in `Program.cs`.

Documents are visible to every authenticated user. If some SOPs need to be
restricted, put them in a separate IIS application with its own ACL — the
single `index.json` is not an authorisation boundary.

---

## Branding

> **The mark is an original design, not the City's official seal.** It was
> drawn for this tool because no official asset was supplied. If the City has
> brand standards, replace the files below — nothing else needs to change.

A gable over a ground line: a homestead on its land. Two elements only, so it
still resolves at 16px in a browser tab.

| File | Used for |
|------|----------|
| `assets/brand/favicon.svg` | Primary favicon; switches tile colour with the OS theme |
| `assets/brand/favicon.ico` | Fallback (16/32/48) for browsers without SVG favicon support |
| `assets/brand/apple-touch-icon.png` | iOS/iPadOS home-screen bookmark (full-bleed; iOS applies its own mask) |
| `assets/brand/logo-mark.svg` | Mark on its own, theme-aware, for `<img>` use |
| `assets/brand/logo-light.svg` | Full lockup for light backgrounds — documents, email, print |
| `assets/brand/logo-dark.svg` | Same lockup, dark-background step |

The site's topbar **inlines** the mark rather than linking an image, so the
tile can read the theme tokens and recolour instantly on toggle.

### Colours

Brand hue is a two-step teal — a light step and a dark step chosen for their
own surface, not an automatic flip:

| Token | Light | Dark | Checked |
|-------|-------|------|---------|
| `--brand` (tile) | `#116b63` | `#14786e` | white glyph 6.35:1 / 5.33:1 |
| `--brand-ink` (text, links) | `#0f5f58` | `#2bab9b` | 7.31:1 / 6.14:1 on page |

**Brand colour is deliberately separate from the chart palette.** `--brand*`
drives chrome only — logo, nav, links, focus rings, search highlights. Charts
keep `--series-1…8` and the status colours, which are a validated,
colourblind-checked set. Rebranding therefore cannot break chart legibility.

### Rebranding

1. Edit the four SVGs in `assets/brand/` (and the inline `<svg class="brand__mark">`
   block in `index.html`, `docs.html` and `error.html` — same paths).
2. Update `--brand`, `--brand-ink` and `--brand-wash` in `assets/css/app.css`,
   in all three places: `:root`, the `prefers-color-scheme: dark` block, and
   the `[data-theme="dark"]` block.
3. Update `STROKES_FULL` and `TILE_LIGHT` in `tools/Build-Icons.py` to match,
   then run `python3 tools/Build-Icons.py` to regenerate the raster fallbacks.
4. Change the `.brand__name` / `.brand__sub` text in the three HTML pages.

If you drop in an official logo as a finished image instead, replace the inline
`<svg class="brand__mark">` with an `<img>` and skip steps 1 and 3.

## Design

Colours, chart marks and status roles follow a validated palette: categorical
hues assigned in fixed order and never cycled, one y-axis per chart, status
always paired with a written label rather than carried by colour alone, and
dark mode stepped for the dark surface rather than flipped. Both themes are
defined as CSS custom properties in `assets/css/app.css` — change them there
and the whole site, charts included, follows.
