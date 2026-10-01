# Google Sheets API setup

The CRM reads Google Sheets (and writes School IDs back to the School Master) with a **Google Cloud service account**.
A service account is a robot Google identity: you share the sheets with its email address, exactly as you would with
a colleague. No personal Google password or OAuth consent screen is involved.

## 1. Create the service account (one time, ~10 minutes)

1. Open https://console.cloud.google.com/ with the Google account that owns (or can manage) the sheets.
2. Create a project, e.g. `glf-olympiad-crm` (top bar → project picker → **New project**).
3. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
4. **IAM & Admin → Service Accounts → Create service account**
   - Name: `glf-crm-sync` → **Create and continue** → no roles needed → **Done**.
5. Open the new service account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
   Treat it like a password.
6. Note the service account email, e.g. `glf-crm-sync@glf-olympiad-crm.iam.gserviceaccount.com`.

> If your Google Workspace blocks service-account key creation (org policy `iam.disableServiceAccountKeyCreation`),
> ask the Workspace admin to allow it for this project.

## 2. Give the CRM the key

Put the JSON in the server environment. Either:

```bash
# single line; base64 avoids quoting problems in hosting dashboards
GOOGLE_SERVICE_ACCOUNT_JSON=$(base64 -w0 glf-crm-sync-key.json)
```
or store the file on the server and set `GOOGLE_APPLICATION_CREDENTIALS=/secure/path/glf-crm-sync-key.json`.

Restart the app. **Integrations** stops showing the "credentials are not configured" notice.
Never commit the key file; `.env` is git-ignored.

## 3. Share the sheets

For each spreadsheet, click **Share** and add the service-account email:

| Sheet | Permission | Why |
|---|---|---|
| School Master | **Editor** | the CRM appends a `School ID` column (and `District`) and fills it in |
| Form response sheets (registrations) | Viewer | read only |
| Any other source | Viewer | read only |

Untick "Notify people" — the robot has no inbox.

## 4. Add the sources in the CRM

**Integrations → Add source**, then for each sheet:

- **Spreadsheet URL or ID**: paste the browser URL (`https://docs.google.com/spreadsheets/d/<ID>/edit…`).
- **Sheet (tab) name**: exactly as on the tab, e.g. `Sheet1` or `Form Responses 1`.
- **Source type**: see the README table.
- **Date format**: `DMY` for Indian-locale sheets (`20/09/2026`). Form timestamps use the spreadsheet's locale
  (File → Settings → Locale); use `MDY` if it is United States.
- **Write School ID back**: `Yes` for the School Master only.

- **Only sync rows where column … equals …** (optional): for sheets that mix schools with other rows, e.g. a courier
  tracker with a `Type` column, enter `Type` and `School` so only school rows are synced. Several values can be
  comma-separated.
- **Channel / Partner for every row** (optional): for a tab that lists one partner's schools, e.g. Channel
  `Institutions` and Partner `Shivaji University`. These replace any Channel or Partner column in the sheet.
- **…or Partner from column** (optional): the header of the column holding the partner, e.g. a sales person column on
  a direct-sales tab.

Click **Test**: it confirms access, lists how each column header was mapped and counts the rows that pass the filter. Then **Sync now**.

A sheet that gives only a total student count (e.g. `Total Registration`) with no grade columns is stored as
"Grade not specified" and still counts towards Total Students. Dates written without a year (`28 Sep`) are read as the
current year.

A registration sheet that also lists schools not present in any other sheet can be added **twice**: once as
*School Master* (with School ID write-back, so its schools are created and linked) and once as *School Registration* or
*School + Student Registration* (to mark them registered). Masters sync first, so the registration source then links
every row by its School ID.

### The Google Form https://forms.gle/HQZmrarJdDNBpGgm6

A Google Form stores responses in a linked spreadsheet: in the form editor, **Responses → Link to Sheets**. Share that
spreadsheet with the service account and add it as a source (usually tab `Form Responses 1`). If the form collects both
school registration and grade-wise student counts, choose **School + Student Registration**; if only registration,
choose **School Registration**.

## 5. School ID write-back: what happens to the School Master

On the first sync the CRM:
- generates `SCH000001`, `SCH000002`, … in row order for every new school;
- appends a `School ID` header in the first empty column and writes each row's ID;
- appends a `District` header and fills District where the sheet has none (derived from City, see ASSUMPTIONS).

Existing columns are never renamed, moved or removed. From then on the ID column is the reliable link, so rows can be
sorted, filtered or inserted freely. Do not edit or delete School IDs in the sheet. A typed District in the sheet is
respected, and a District an admin edits in the CRM is written back to the sheet.

If the service account only has Viewer access, the sync still succeeds and shows *"Data synced, but writing School IDs
back to the sheet failed"*; schools keep their IDs in the CRM (matched by row and by name/contacts on later syncs).

## 6. Making future forms School-ID aware

Add a short-answer question **School ID** (validation: regular expression `^SCH[0-9]{6}$`). Coordinators can find their
ID in the School Master or ask their Sales SPOC. Rows carrying a valid School ID link with certainty; rows without one go
through name/city/contact matching, and anything uncertain waits in the admin review queue.

## 7. Quotas and failures

The Sheets API allows 300 read requests per minute per project; one sync = 1–2 requests per source, so the default
15-minute schedule is far below the limit. Temporary errors (network, 429, 5xx) are retried three times with backoff inside a
sync; if the sync still fails the source shows **SYNC ERROR** with the message and the last successful sync time, the CRM
keeps serving the last synced data, and the scheduler retries after 1, 2, 4, 8… minutes (capped at the source frequency).
Each sync is a single database transaction, so a failed or repeated sync never creates partial or duplicate records.
