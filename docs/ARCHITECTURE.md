# Architecture

## 1. Requirements analysis (condensed)

Management needs one source of truth for the funnel **Total schools → Kit distributed → School registered → Student
registered**, sliceable by State → District → City → School and by Channel → Partner → School, plus Sales SPOC, Board,
kit/registration status and date range. The operational data lives in several Google Forms/Sheets with inconsistent
headers and no reliable key. Therefore the core of the system is an **integration layer** that (a) normalises any sheet
into one schema, (b) assigns a permanent School ID and (c) links every other sheet's rows to that ID, with a human
review step whenever a link is uncertain. Everything the UI shows is computed from the database with one shared filter
builder, so KPIs, tables, charts and exports always agree.

## 2. Database schema (PostgreSQL, `migrations/001_init.sql`)

| Table | Purpose / key columns |
|---|---|
| `schools` | School Master. `school_id` PK `SCH000001…` from a sequence (never reused, never updated). All spec fields incl. `district`, `partner_id`, `kit_given` (**generated column** `kit_drop_date IS NOT NULL`), `school_registered`, `registration_date/source/form`, `last_registration_sync`, lineage (`source`, `source_id`, `source_sheet`, `source_row`, `last_synced_at`), audit (`created_*`, `updated_*`), `district_origin` (SHEET/LOOKUP/MANUAL), `channel_raw`/`sales_spoc_raw` (value as typed in the sheet), `is_demo` |
| `school_contacts` | principal / coordinator (synced), and later any number of teachers (`contact_type`, `subject`, `address`) |
| `channels` | Channel Master (`name`, `aliases[]`, `is_active`, `created_via` MANUAL/SYNC) |
| `partners` | Partner Master, optionally under a channel (Channel CoE → Partner Shivaji University) |
| `users` | User Master: `name, email, team, role, state, city, status` + `access_role` (ADMIN / MANAGEMENT / NONE), `aliases[]`, password hash. Sales SPOC = `schools.sales_spoc_id → users` |
| `sessions` | hashed session tokens |
| `student_registrations` | one row per form response: `grade_3_count … grade_10_count`, `total_students` (**generated** sum), `is_superseded`, lineage |
| `school_student_totals` (view) | effective grade-wise totals per school (non-superseded rows) |
| `data_sources` | configurable sources: `source_id, source_name, spreadsheet_id, sheet_name, source_type, status, last_sync, sync_frequency_minutes` + `connection_status`, `last_successful_sync`, `last_error`, `consecutive_failures`, `column_mapping` (per-source overrides), `date_format`, `header_row`, `writeback_enabled`, `student_mode` |
| `field_aliases` | global header → field dictionary (editable in Settings) |
| `source_rows` | identity + content hash of every synced row (idempotency, change detection, lineage) |
| `duplicate_reviews` | possible duplicates / unmatched rows awaiting admin decision, with candidate schools, scores and reasons |
| `sync_logs`, `sync_row_issues` | every sync run with counts, message, ignored headers; row-level warnings/errors |
| `audit_logs` | field-level `old_value / new_value / changed_by / changed_at`, for manual and sync changes |
| `geo_city_district` | State + City → District lookup (editable) |
| `follow_ups` | **future** follow-up module (structure only: date, by, interaction type, outcome, next follow-up, remarks) |
| `app_settings` | key/value settings for later use |

A separate `kit_distributions` table was **not** created: the kit facts (date, count) already live on the School Master
row, and duplicating them would create two sources of truth. A Kit Distribution *source type* exists for teams that keep
a separate kit log; it updates the same school fields.

## 3. API (all JSON under `/api`, session cookie auth)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Lookups | `GET /lookups` (geo tree, boards, channels, partners, users, demo counts) |
| Dashboard | `GET /dashboard/metrics?<filters>`, `GET /dashboard/breakdown/:dimension?<filters>&sort&dir` (dimension: state, district, city, channel, partner, spoc, board) |
| Schools | `GET /schools?<filters>&q&sort&dir&page&pageSize`, `GET /schools/export?format=csv\|xlsx&<filters>`, `GET /schools/:id`, `POST /schools`*, `PATCH /schools/:id`*, `POST /schools/:id/student-registrations`* |
| Teachers | `GET /contacts?<filters>` |
| Masters | `GET/POST/PATCH /channels`*, `/partners`*, `/users`* |
| Integrations | `GET /integration/status`, `GET/POST/PATCH /sources`*, `POST /sources/:id/test`*, `POST /sources/:id/sync`*, `POST /sync-all`*, `GET /sources/:id/logs`, `GET /sync-logs/:id/issues` |
| Review | `GET /reviews`, `POST /reviews/:id/resolve`* (`link` + school_id, `create`, `dismiss`) |
| Settings | `GET/POST/DELETE /field-aliases`*, `GET/POST /geo`*, `GET /audit`*, `POST /demo/purge`* |

`*` = ADMIN only. Filters (identical everywhere): `state, district, city, channel, partner, spoc, board` (comma-separated
lists; `__none__` = "not set"), `kit=yes|no`, `registered=yes|no`, `date_field=kit|registration|student`, `date_from`, `date_to`, `q`.
State-changing requests require the `X-Requested-With: glf-crm` header (CSRF defence together with `SameSite=Lax` cookies).

## 4. Google Sheets integration strategy

1. **Adapter** (`src/sheets/googleAdapter.js`): service-account JWT → OAuth token → `values.get` (whole tab, formatted
   values) and `values.batchUpdate` (write-back). Retries network/429/5xx errors with exponential backoff. A CSV
   `fixture` adapter with the same interface backs demo data and tests, including simulated outages.
2. **Mapping** (`src/sync/mapping.js`): each header is normalised (lower case, punctuation removed) and resolved by
   per-source override → global alias table → grade pattern (`Grade 3`, `Class III`, `No. of students in Std 3`, `3rd grade`).
   Unknown columns are ignored and reported on the sync log, never guessed.
3. **Normalisation** (`src/util/normalize.js`): trims/title-cases places, canonical state names (`MH` → Maharashtra),
   phones to 10 digits, lower-case emails, 6-digit PIN, dates in DMY/MDY/ISO/"20 Sept 2026"/serial form, whole
   non-negative counts. Invalid optional values → warning and the field is left unchanged; invalid grade counts → the row is
   rejected (a wrong count would corrupt totals); missing school name → rejected.
4. **Matching** (`src/sync/matcher.js`): School ID column first. Otherwise a score from name similarity (Dice
   coefficient), city (same +, different −), principal contact, school email, coordinator phone and PIN. Auto-link only
   when the best candidate is clearly unique (score ≥ 70, name ≥ 85 % similar, no PIN conflict); anything between 40 and 70,
   or ambiguous, goes to **admin review**. Within the School Master, a school already owned by another row is never
   auto-linked (a duplicate row in the master is flagged, not merged). Registration rows with no candidate are flagged as
   *unmatched*; the admin can link, create a new school or dismiss.
5. **Upsert** (`src/sync/syncEngine.js`): one database transaction per sync, a savepoint per row. `source_rows` stores a
   hash of each mapped row; unchanged rows are skipped, changed rows update only the columns that sheet provides, and a
   field-level audit entry is written for every change. Sources sync in dependency order (master → kit → registrations
   → students). A Postgres advisory lock prevents two syncs of the same source at once.
6. **Write-back**: after commit, new School IDs (and derived Districts) are written to the School Master in one batch.
   A write-back failure marks the run PARTIAL but keeps the synced data.
7. **Monitoring**: `data_sources.connection_status` (CONNECTED / SYNC ERROR), `last_successful_sync`, `last_error`,
   per-run logs and row issues, shown on the Integrations page and in the top bar.

Adding a new form/sheet = one row in `data_sources` (via the UI) + optionally some aliases. No schema or code change.

## 5. Dashboard data model

All numbers come from one query shape over `schools s LEFT JOIN school_student_totals t` with the shared `WHERE`:

| Metric | Definition |
|---|---|
| Total Schools | `count(*)` |
| Schools with Kit / Kits Distributed | `count(*) FILTER (WHERE kit_given)` |
| Total kits | `sum(number_of_kits) FILTER (WHERE kit_given)` |
| Kit Coverage % | Schools with Kit / Total Schools × 100 |
| Registered Schools | `count(*) FILTER (WHERE school_registered)` |
| School Registration % | Registered / Total × 100 |
| Total Student Registrations | `sum(t.total_students)` (Grade 3 + … + Grade 10) |
| Avg Students per Registered School | Total Students / Registered Schools |
| Kit-to-Registration % | Registered Schools **with Kit** / Schools with Kit × 100 |

Breakdowns group the same aggregates by state, district (within state), city, channel, partner (within channel), SPOC
or board. No scores, ratings or rankings are computed — only counts and ratios of recorded facts.

## 6. Security

- Passwords: scrypt with per-user salt. Sessions: random 256-bit tokens, stored hashed, HttpOnly + SameSite cookies.
- Role checks on every write endpoint (server-side; the UI only hides buttons).
- Google credentials are read from environment variables only and never returned by any endpoint.
- CSV export neutralises spreadsheet formulas (`=`, `+`, `-`, `@` prefixes).
- All SQL is parameterised; sort columns are whitelisted.
