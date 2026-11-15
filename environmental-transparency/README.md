# IMBY — environmental development transparency

A map of proposed data centers, power infrastructure, industrial, logistics, and major transportation projects across **California**, built from official public records.

**Real public records → Bright Data retrieval → Gemini extraction → deterministic validation → Supabase knowledge base → interactive map → official participation.**

Every figure on the map traces back to a verbatim passage in an official document. Model output is treated as a *claim*: a fact is marked **validated** only when its quote is found in the cited source text, its number appears in that quote, and its date appears in that quote.

---

## Quick start

```bash
npm install
npm run dev                     # http://localhost:3000 (predev copies the MapLibre worker into /public)
```

Requires `.env.local` with the variables in `.env.example`. Optional additions:

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash` | Used when `GEMINI_MODEL` is overloaded (503/504) |
| `INGEST_MAX_DOCS` | `3` | Documents (page + attachments) per ingestion |
| `PUBLIC_AI_DAILY_LIMIT` | `300` | Daily ceiling on public `/api/ask` model calls |

**Database:** the app uses the already-provisioned Supabase tables (`projects`, `documents`, `facts`, `impact_features`, `participation_events`) with RLS on. **No migrations are required.** A private Storage bucket `source-cache` is created automatically on first ingestion.

### Ingest an official source (protected)

The ingestion endpoint requires `INGEST_ADMIN_TOKEN` (server-side only). The CLI reads it from `.env.local`:

```bash
npm run ingest -- --url https://ceqanet.lci.ca.gov/2026070839
npm run ingest -- --url "https://santaclara.legistar.com/LegislationDetail.aspx?ID=5065822&GUID=B3969212-21A9-4C6B-8130-1F81BCF723F5"
npm run ingest -- --discover "santaclara.legistar.com data center mitigated negative declaration"
# --force re-fetches and re-extracts; --max-docs N; --host http://localhost:3100
```

The UI polls the knowledge base every 12 s (a DB read only, with no scraping or AI). New or updated records appear with a toast and a "New" badge. Run logs are shown under **Pipeline**.

### Tests

```bash
npm run test               # 41 unit tests: parsers (real fixtures), validation, model-output rejection, Bright Data failures, SSRF guard
npm run test:integration   # 11 live tests vs. Supabase + running app (no Bright Data/Gemini spend)
npm run test:e2e           # Headless Chrome UI checks against the running app (uses ~2 Gemini calls)
npm run lint && npm run typecheck && npm run build
npm run gis:fetch          # refresh baseline GIS layers in public/gis/
```

---

## Statewide indexing campaign (`src/lib/campaign/`)

A controlled, resumable job that indexes California developments at two depths.

```bash
npm run campaign -- create --from 2025-11-15 --to 2026-11-15 --max-requests 2489 --max-usd 20 \
                           --pilot-requests 100 --pilot-gemini 150 --pilot-enrichments 75
npm run campaign -- run        # bounded steps until it pauses itself (pilot cap, budget, or done)
npm run campaign -- report     # add --json for the full report
npm run campaign -- approve --requests 2389 --gemini 1500 --enrichments 800   # next phase
```

1. **Discovery:** the CEQAnet statewide search export (CSV), in monthly windows, is fetched directly from the State Clearinghouse. These requests cost no Bright Data, because Bright Data declines `.ca.gov` hosts.
2. **Identity:** filings are grouped by **SCH number**. A new filing for a known SCH number becomes a new document of that project, never a new development. Filing portal URLs dedupe documents. Older records without an SCH number are matched by exact name plus jurisdiction.
3. **Relevance** (`classify.ts`): deterministic rules covering data centers, power, industrial and manufacturing, logistics, and major transportation.
   - Negated mentions ("would not include … data centers") are ignored.
   - Policy actions (moratoria, ordinances, leases, plan updates) are excluded, as are routine work and exemption-only filings (except data centers).
   - Every decision stores the rule and the matched text (`index.relevance`).
4. **Level 1 (lightweight):** title, agency, dates, procedural status, and location come from structured filing fields only (`method=parsed`). Each fact quotes its CSV column and links to its filing.
5. **Location** (`locate.ts`): a marker is created only if every check passes:
   - seconds-level precision;
   - a single listed county;
   - the point falls inside that county (U.S. Census TIGERweb boundaries);
   - the coordinate is not shared by unrelated filings (placeholders);
   - the title doesn't describe a linear, area-wide, or programmatic scope.
   
   Otherwise the project is listed but **not mapped**, and the reason is stored (`location.verification`).
6. **Level 2 (enriched):** for proposed and under-review projects, highest priority first:
   - The CEQAnet document and its notices go through Gemini extraction and the existing verbatim validation (direct fetch).
   - Then one Bright Data SERP query by SCH number and title (`-site:ceqanet`), official hosts only. A result is attached only if its text contains the SCH number, a case number, or the exact title plus place (`identity.cross_reference`).
7. **Budget** (`budget.ts`):
   - Every Bright Data attempt, retries included, passes a gate that records it in a write-ahead ledger before it is sent.
   - The account's own counts (`/zone/cost`, a management API that isn't billable) are reconciled each step, and the larger count governs.
   - Requests stop at the campaign request cap, the USD cap (at the account-derived rate), or the current phase cap (the pilot). Gemini calls and enrichments also have per-phase caps.
8. **Post-processing** (no retrieval):
   - `npm run campaign -- cleanup` normalizes ALL-CAPS names, stray prefixes, whitespace, and double-encoded punctuation. It also fills `developer` from an explicit "by <entity>, LLC" in the official title.
   - `npm run campaign -- summarize` writes AI summaries for basic records from their stored description and fields only. A summary is discarded if it states a number not in that text, makes a health claim, or runs long. Each kept summary records `summary.provenance`.
9. **Queue:** checkpointed in Supabase Storage (`campaigns/<id>/`). It uses a single-runner lease, retries with backoff (3 attempts), and idempotent tasks. Raw exports, SERP results, and pages are cached, so a resumed step never re-spends.

## How the pipeline works (`src/lib/pipeline/ingest.ts`)

1. **Discover** — Bright Data **SERP API** (`brd_json=1`). Results are filtered to an explicit allowlist of official hosts (`src/lib/config.ts`). The first result not already in the knowledge base is chosen.
2. **Retrieve** — Bright Data **Web Unlocker** fetches the page, then its highest-value attachments (notices first, large EIR volumes skipped). HTML and PDF are both supported (`unpdf`, with page markers for citations).
   - *Bright Data's network policy refuses government-classified hosts (`*.ca.gov`, `santaclaraca.gov`) until the account completes KYC.* For those allowlisted hosts the app does a direct, SSRF-guarded fetch. Every document records which method retrieved it (`document.retrieval_method`), and the UI shows it. City of Santa Clara **Legistar** records are retrieved through Web Unlocker.
   - Raw responses are cached for 24 h in Supabase Storage, so re-runs and hot reloads never re-spend credits.
3. **Dedupe** — documents are hashed (SHA-256 of normalized text). If every document is already stored, the run ends as `unchanged` **before** any Gemini call.
4. **Extract** — one Gemini call with a strict JSON schema (Zod → JSON Schema, `responseJsonSchema`). All fields are nullable, and every claim carries `doc` + verbatim `quote`. Output that fails the schema is rejected, never patched.
5. **Validate** (`validate.ts`, pure and unit-tested):
   - **Quotes:** each quote must be found in the cited document (whitespace/punctuation-insensitive), and the page is recorded.
   - **Numbers and dates:** numbers must appear in their quote, and dates must appear in their quote.
   - **Units:** units are checked against a known list.
   - **Hearings and deadlines:** shown only if verified, and submission emails/URLs must appear verbatim in the source.
   - **CEQAnet structured fields override the model:** coordinates (DMS→decimal), review-period dates, document type → status, and the lead-agency contact.
   - **Rejection:** records with no verifiable claim are rejected.
6. **Geography** — reported CEQAnet coordinates are used if present; otherwise the U.S. Census geocoder is used and the location is labeled **approximate**. Schools named in a filing are matched to CDE school points. No parcel footprints or impact boundaries are invented.
7. **Persist** (`persist.ts`):
   - **Identity matching:** projects are matched by SCH number → case number → name.
   - **Revisions:** revised documents become new versions, and earlier evidence is never overwritten.
   - **Rollback:** every insert is tracked, and on failure all of them are deleted, so no partial records remain.
8. **Cache text** — document text is stored for grounded Q&A.

### Data model conventions (existing schema)

| Table | Usage |
|---|---|
| `projects` | `status` ∈ proposed/under_review/approved/…/unknown; `location_precision` ∈ reported_coordinates/geocoded_address/unlocated; `summary` = AI explanation |
| `documents` | `source_url`, `content_hash`, `retrieved_at`, `version` |
| `facts` | `field` namespaces: `identity.*`, `metric.<topic>.<name>`, `consideration.<topic>.<kind>`, `timeline.*`, `location.*`, `community.*`, `participation.*`, `document.*`. `method` ∈ reported (model, quote-checked) / parsed (structured record) / derived. `review_status` ∈ validated / unverified. `page_or_passage` = JSON `{quote, page, label, context, …}` |
| `participation_events` | `comment_period` / `hearing`; status is recomputed from `deadline_at` at read time |
| `impact_features` | `project_site` (proposed) and `reported_nearby_school` (baseline) GeoJSON with `spatial_meaning` |

PostGIS isn't used: no DDL access was available, and the geometry is points only. Spatial operations (point-in-tract, distances) run in Turf.js.

## Entry flow (`src/components/Landing.tsx`)

- **Landing screen:** the app opens on the introduction ("What's being built near you"), live statistics (developments tracked, open for public comment, mapped, counties covered), and a "Where do you live?" prompt with autocomplete.
- **Place matching:** places resolve against `public/gis/ca-places.json`, which holds every California city, census-designated community, and county from U.S. Census TIGERweb (`npm run gis:fetch ca-places.json`). Unknown names are reported, never guessed.
- **After choosing:** the map opens framed on that place, and the sidebar shows "Developments near <place>" in place of the introduction. The choice is kept in the URL (`?place=<Census GEOID>`, or `?place=ca` for statewide), so links and reloads keep it. **Change**, or the logo, returns to the landing screen. A shared `?project=` link opens directly.

## Participation (`src/lib/participation.ts`)

- **Sidebar.** Projects are scoped to the map area (or all matches) and ordered in this sequence:
  1. verified open comment windows, earliest deadline first;
  2. verified upcoming windows or hearings;
  3. other projects under review, nearest to the map center first;
  4. decided projects;
  5. projects with unverified status.
  
  The first two tiers form **Action available**, with the deadline shown in Pacific time and a link to Participate.
- **Participate** is built only from stored official-record facts, with no model calls:
  - the agency and department, and the contact person, email, phone, and mailing address;
  - comment status, with an upcoming / open / closed state and the deadline at 11:59 PM Pacific;
  - the stated submission channel: a portal URL, or an email listed in the filing;
  - hearings, with date, time, location, and online details kept only if verbatim in the source;
  - notices and source documents, and next steps once a period has closed.
  
  Missing items are listed as not found. Nothing is submitted for the user.
- **Data.** No schema change was needed:
  - `participation_events` holds the verified deadline and channel, and each event's details live in its `participation.event.<id>` fact.
  - The agency contact is the `participation.lead_agency_contact` fact.
  - Statewide records get the same events and contacts from structured CEQAnet fields (`npm run campaign -- backfill-participation`, and automatically for new lightweight records).

## Map views (`src/lib/client/map-state.ts`)

The map has three deterministic views; `layerPlan()` decides every layer's visibility (unit-tested).

| View | Shown |
|---|---|
| **Explore** (no project) | Category landmark markers only (always visible; there's no hide toggle): server = data center, bolt = power, factory = industrial, warehouse = logistics. The corner dot shows review status; a green ring means comments are open. |
| **Project** (Overview / Community / Participate) | Same as Explore, with the selected marker emphasized and the others dimmed. |
| **Impacts** | **OEHHA CalEnviroScreen 4.0** baseline: the site's tract is outlined, tracts within 3 km are shown lighter, and everything else is hidden. Toggle **Full region** for the whole study area. The indicator selector covers overall score, diesel PM, PM2.5, traffic, and asthma. **CDE 2025-26 schools** within 3 km are available as a toggle, clustered at low zoom and off by default. **Proposed** adds schools named in the filing and a 1 km *reference* ring. |

The map is shaded by statewide percentile. Clicking a tract shows raw values with units, percentiles, and attribution. Clicking a project shows its characteristics, and the side panel holds the evidence. Baseline polygons are existing conditions only. No dispersion, plume, or impact footprint is drawn.

## Security

- Secrets are used only in server modules (`import "server-only"`). There are no `NEXT_PUBLIC_` secrets. Browser code never touches Supabase directly.
- `/api/ingest` requires a bearer token (constant-time compare), validates input with Zod, accepts allowlisted https hosts only, and runs one ingestion at a time.
- Fetching is SSRF-guarded: IP literals and private/link-local/loopback resolutions are refused, and every redirect hop is re-validated.
- Scraped text is untrusted. Model prompts say so, it is rendered as text (never HTML), and resident notes are never treated as instructions.
- `/api/ask` is rate-limited per client, capped daily, and schema-validated. Answers are cached per project, question, and evidence set.
- RLS stays on. The publishable key cannot write (verified by integration tests).

## API

| Route | |
|---|---|
| `GET /api/projects` | list + GeoJSON |
| `GET /api/projects/[id]` | full record (documents, facts, participation, features) |
| `GET /api/projects/[id]/export?format=json\|geojson` | download |
| `GET /api/export` | all projects as GeoJSON |
| `POST /api/ingest` | protected ingestion; `GET` = recent run logs |
| `POST /api/campaign` / `GET` | protected statewide indexing control and report |
| `POST /api/ask` | grounded Q&A over stored source passages |

## Demo walkthrough (≈3 min)

1. **Problem.** Open the app. The sidebar shows 5 developments, and **Montague Point** is *open for comment*. "These records exist across CEQAnet, city Legistar, and PDFs. Here they're in one place."
2. **Discovery.** Point out the status colors on the map. Click **Northtown Backup Generating Facility** (42 diesel generators, 97.3 MW).
3. **Understanding.** In **Overview**, show the AI summary (labeled) and the reported figures. Click **97.3 MW** to open the evidence card: verbatim quote, official CEQAnet link, retrieval method, hash.
4. **Environmental exploration.** Open **Impacts → Existing**: the baseline appears around the site, with its tract outlined and neighbors lighter. Switch the indicator to Diesel PM, click a tract for its values, and enable schools. Switch to **Proposed**: the reported site, schools named in the filing, and the 1 km reference ring. Click a school to see its evidence.
5. **Community → Participate.** Open **Montague Point → Community** and ask a question to get a cited answer. Open **Participate**: comment open until Dec 17, 2026 (11:59 PM PST, verified from the filing), the stated submission email, the lead agency contact (person, email, phone, mailing address), hearings, and official notices. Anything the records don't state is marked as not found. IMBY doesn't draft or send comments.
6. **Bright Data payoff.** Open **Pipeline**, then in a terminal run either:
   - `npm run ingest -- --url https://ceqanet.lci.ca.gov/2024070671/2`
     - This is Comstock's *Notice of Determination*. It attaches to the existing project by SCH number, flips status **Under review → Approved**, adds a document and timeline entry, and corrects the lead agency to City of Santa Clara.
   - `npm run ingest -- --discover "santaclara.legistar.com data center architectural review mitigated negative declaration"`
     - SERP discovery, then Web Unlocker retrieval of a new Legistar record, producing a **new pin**.

   Watch the run steps in the Pipeline panel, then the toast and the updated record. Download its JSON/GeoJSON from the drawer.

## Known limitations

- The CalEnviroScreen and school baseline layers still cover only the original Bay Area study area. Statewide projects outside it show no tract baseline in **Impacts**.
- Basic (lightweight) records carry no environmental metrics until they are enriched.

- Bright Data Web Unlocker is refused for `.gov` hosts until the account completes KYC. Those sources use a labeled direct fetch.
- Large EIR volumes (>3 MB) aren't retrieved, so some topics (e.g. Montague air quality) are honestly "not in the retrieved record".
- `gemini-3.8-flash` was intermittently overloaded during development. Ingestion falls back to `GEMINI_FALLBACK_MODEL` and logs which model served each run.
- CEQAnet itself lists "City of San Jose" as lead agency on Comstock's MND (a source-data inconsistency). The later NOD lists City of Santa Clara.
- Rate limiting is in-memory (per server instance). Use a shared store before multi-instance deployment.
