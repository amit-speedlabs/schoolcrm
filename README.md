# GLF AI OLYMPIAD 2026 — School & Teacher CRM

A functional web CRM that tracks every school approached for the GLF AI Olympiad 2026: school kit distribution, the
channel/partner and Sales SPOC responsible, school registration, and grade-wise student enrolment. Data flows in from
Google Forms / Google Sheets; nobody re-enters what is already in a sheet.

```
Google Forms → Google Sheets → Google Sheets API → Integration / normalisation layer → PostgreSQL → Web CRM → Dashboard
```

Dashboards, filters and exports are computed from the central database, never from Sheets directly.

| | |
|---|---|
| Stack | Node.js 20+ (Express), PostgreSQL 13+ / Supabase, plain HTML/CSS/JS front end (no build step) |
| Dependencies | `express`, `pg`, `exceljs` (Google auth is implemented with Node's `crypto` + `fetch`) |
| Roles | `ADMIN` (full access) and `MANAGEMENT` (view, search, filter, export) |
| Tests | 18 automated end-to-end tests (`npm test`), covering the 16 checks in the spec |

More detail:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): requirements analysis, database schema, API, sync strategy, dashboard data model
- [docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md): Google Cloud / service account / sheet sharing, step by step
- [docs/DEPLOY.md](docs/DEPLOY.md): putting it online with Render + Supabase, step by step
- [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md): assumptions, limitations and what could not be fully automated

---

## 1. Quick start (local)

Requirements: Node.js 20+, PostgreSQL 13+ (or a Supabase project).

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL (and ADMIN_EMAIL / ADMIN_PASSWORD)
createdb glf_crm              # skip for Supabase
npm run migrate               # creates all tables (also runs automatically on start)
npm start                     # http://localhost:3000
```

### Admin user setup
Either set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` before the first start (created only if no admin exists yet), or run:

```bash
npm run create-admin -- admin@yourdomain.in 'a-strong-password' "Your Name" ADMIN
npm run create-admin -- ceo@yourdomain.in 'another-password' "CEO" MANAGEMENT
```
Further users are added in the app under **Users**. Sales SPOCs are users with CRM access `NONE`.

### Demo data (optional, clearly labelled)
```bash
npm run seed:demo
```
Loads 20 **DEMO** schools across Maharashtra, Gujarat, Uttar Pradesh, Karnataka and other states by syncing the CSV
"sheets" in `fixtures/demo/` through the *same* pipeline used for Google Sheets (mapping, matching, School ID
generation, write-back, review queue). It includes a school-name spelling variant and an unknown school (both land in
the admin review queue), an invalid email and an invalid grade count (shown as sync warnings/errors), and a school
that re-submitted its student numbers.

Demo logins: `admin@glf-demo.local / DemoAdmin@2026` (ADMIN), `management@glf-demo.local / DemoView@2026` (MANAGEMENT).

The seeder refuses to run if production schools exist. Demo rows carry a DEMO label in the UI and a `DEMO DATA` banner is
shown while any exist. Remove them before going live: **Settings → Demo data → Delete all demo data**. The two demo
logins are not removed by that button; once your real admin exists, set them to INACTIVE under **Users**.

### Running the tests
```bash
createdb glf_crm_test
TEST_DATABASE_URL=postgres://postgres@localhost:5432/glf_crm_test npm test
```
The test database is wiped on every run. The browser test runs only if Playwright is installed.

---

## 2. Connecting the real Google Sheets

1. Create a Google service account and put its JSON key in `GOOGLE_SERVICE_ACCOUNT_JSON` (see [docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md)).
2. Share each spreadsheet with the service account's email: **Editor** for the School Master (so School IDs can be
   written back), **Viewer** is enough for form-response sheets.
3. In the CRM go to **Integrations → Add source**, paste the spreadsheet URL, the tab name and pick the source type:

| Source type | Typical sheet | What it does |
|---|---|---|
| School Master | the existing 15-column master | creates/updates schools, generates School IDs, writes them back |
| School Registration | responses of the registration form (e.g. https://forms.gle/HQZmrarJdDNBpGgm6) | marks the matched school as registered, keeps the earliest registration date |
| Student Registration | responses with grade-wise counts | stores Grade 3–10 counts per response; total is calculated |
| School + Student Registration | one form that captures both | does both of the above |
| Kit Distribution | a separate kit log (optional) | updates kit date / kits / channel / partner / SPOC |

4. Click **Test** (shows how each column was mapped), then **Sync now**. After that, each source syncs automatically at
   its own frequency (default every 15 minutes). **SYNC NOW (all)** syncs every enabled source in the right order.

Adding another form or sheet later is just another source: no code changes. If its headers are unusual, map them under
**Settings → Field mapping** (global) or in the source's *column mapping overrides* (e.g. `{"Name of Institution": "school_name"}`).

### Sample Google Sheet templates
`templates/*.csv` contain the recommended headers for each sheet type (import into Google Sheets via File → Import).
Future forms should include a **School ID** question; rows that carry a School ID are linked with certainty.

---

## 3. What is where in the app

| Navigation | Contents |
|---|---|
| Dashboard | KPI cards (Total Schools, Kit Distributed, Schools Registered, Student Registrations), coverage/conversion %, funnel, grade-wise chart, State and Channel tables; all driven by the 10 mandatory filters |
| Schools | searchable, sortable, paginated table with all required columns; CSV/Excel export of the filtered set; Add school (admin) |
| School profile | school, kit, registration, grade-wise student data, source information, linked sheet rows and change history |
| Teachers | principals and coordinators (from the School Master) |
| Kit Distribution / Registrations / Student Enrolment | filtered views of the school data with the relevant columns and KPIs |
| Reports | drill-downs: State → District → City → School, Channel → Partner → School, Sales SPOC, Board; sortable by each metric |
| Integrations | Google Integration Status (CONNECTED / SYNC ERROR + last successful sync), sources with Test / Sync now / Enable-Disable / Edit / Logs & errors, and the duplicate review queue |
| Users | User Master (also the Sales SPOC list) |
| Settings | Channel Master, Partner Master, header field mapping, City → District lookup, audit log, demo data removal |

---

## 4. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL / Supabase connection string |
| `DATABASE_SSL` | for hosted DBs | `true` to connect with SSL (Supabase) |
| `PORT` | no | HTTP port (default 3000) |
| `COOKIE_SECURE` | in production | `true` when served over HTTPS |
| `SESSION_TTL_HOURS` | no | login session length (default 12) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | first run | bootstrap the first admin if none exists |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | for Google | service-account key JSON (raw or base64) |
| `GOOGLE_APPLICATION_CREDENTIALS` | alternative | path to the key file instead of the JSON |
| `SYNC_SCHEDULER` | no | `false` disables automatic syncing (manual Sync Now still works) |
| `SYNC_TICK_SECONDS` | no | how often the scheduler checks for due sources (default 60) |
| `FIXTURE_DIR`, `TEST_DATABASE_URL` | demo/tests | CSV fixture location and test database |

Credentials are only read on the server. The UI and API never return them.

---

## 5. Deploying

**Render + Supabase (recommended):** follow [docs/DEPLOY.md](docs/DEPLOY.md). The `render.yaml` Blueprint in the repo root
configures the web service; you create the accounts and paste in the database URL and first admin login.

Any other Node host works too (Railway, a VM, Cloud Run). Set the environment variables above, run `npm ci && npm start`.
Migrations run on start. Put it behind HTTPS and set `COOKIE_SECURE=true`. With Supabase, use the **Session pooler**
connection string (not the transaction pooler on port 6543, which breaks the sync advisory lock) and `DATABASE_SSL=true`.
Run a single instance (or set `SYNC_SCHEDULER=false` on all but one instance); concurrent syncs of the same source are
also prevented by a Postgres advisory lock.

---

## 6. Project layout

```
migrations/            SQL schema (001) + reference data: header aliases, city→district lookup (002)
src/server.js          Express app, security headers, startup (migrate, bootstrap admin, scheduler)
src/auth.js            scrypt password hashing, DB-backed sessions, role guards, CSRF header check
src/routes/api.js      REST API
src/services/          filtered queries + metrics (schools.js), exports, validation, audit, master-data resolution
src/sync/              mapping layer, school matcher, sync engine, review resolution, scheduler
src/sheets/            Google Sheets API adapter (service account) and CSV fixture adapter
public/                the web app (index.html, app.js, styles.css)
fixtures/demo/         DEMO sheets (CSV) used by npm run seed:demo
templates/             blank sheet templates with recommended headers
test/                  end-to-end tests
```
