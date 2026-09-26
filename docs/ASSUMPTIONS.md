# Assumptions, limitations and what is not fully automated

## Assumptions

1. **Stack**: PostgreSQL (works unchanged on Supabase) with a Node.js server and a no-build HTML/JS front end, chosen for
   fast loading and simple hosting.
2. **The Google Form https://forms.gle/HQZmrarJdDNBpGgm6 could not be opened from the build environment**, so its exact
   questions are unknown. The integration does not depend on them: headers are mapped by alias/pattern and can be
   overridden per source. It is assumed the form collects at least the school name and city (and ideally School ID,
   email, principal contact and grade-wise counts). Click **Test** after adding it to see the mapping.
3. **Presence of a row in a School Registration source = the school registered**, unless the sheet has a column like
   "Registered?" with Yes/No. The registration date is the row's date/timestamp; the earliest one is kept.
4. **Multiple student responses from one school in the same sheet**: by default the *latest* response replaces earlier
   ones (schools usually resubmit corrected numbers). A source can be switched to *add all responses* (e.g. one response
   per class section). Responses from different sources are added together.
5. **District** is not in the School Master. It is derived from State + City using an editable lookup
   (about 80 common cities pre-loaded). A District typed in a sheet wins over the lookup; a District set manually by an
   admin wins over both and is written back to the sheet. Cities not in the lookup show "Not set" until added.
6. **Partner** is not in the School Master. It comes from a Partner column in any source (e.g. a Kit Distribution sheet)
   or is set by an admin on the school. The demo data uses a Kit Distribution sheet for this.
7. **Channel and Sales SPOC values** typed in sheets are matched to the Channel Master / User Master (case-insensitive,
   plus aliases). Unknown values are added automatically, marked "from sheet", so no data is lost; admins can rename them,
   add aliases for spelling variants, or deactivate them.
8. **Sheet is the source of truth** for the fields it contains. An admin edit to such a field (e.g. principal name) is
   overwritten on the next sync unless the sheet is also corrected; the edit dialog says so. CRM-only fields (District
   when derived/manual, Partner when no sheet has a Partner column) are not overwritten. A manual School Registration
   edit is kept unless a registration sheet later contains a row for that school.
9. **Blank cells in the School Master clear the CRM value** (e.g. removing the Kit Drop Date sets Kit Given = NO).
   Blank cells in other sources never clear School Master data.
10. **Phone numbers** are valid when they reduce to 10 digits (after removing +91 / leading 0). **PIN codes**: 6 digits,
    not starting with 0. **Dates**: DMY by default (configurable per source).
11. **Date range filter** applies to the Kit Drop Date by default; it can be switched to Registration Date or Student
    Registration Date.
12. **Student counts from a school that is not marked registered** are still counted as student registrations (factual);
    the two statuses are tracked independently, as specified.
13. Initial roles are ADMIN and MANAGEMENT. Sales SPOCs are User Master entries without login.

## Limitations / not fully automated

1. **Google credentials must be created by a person** (service account + key + sharing the sheets). This cannot be
   automated from the application. See [GOOGLE_SETUP.md](GOOGLE_SETUP.md).
2. **Possible duplicates need a human decision.** The CRM never merges or creates a school when a match is uncertain;
   the admin resolves each item in Integrations → Review (link / create new / dismiss).
3. **Rows deleted from a sheet**: student-registration rows disappear from the CRM on the next sync (latest data wins).
   Schools are **never** deleted automatically when a School Master row disappears; an admin must decide.
4. **Write-back needs Editor access** to the School Master. Without it, IDs live only in the CRM and later links rely on
   row position + name/contact matching (documented, and reported on every sync as PARTIAL).
5. **District lookup coverage** is limited to the pre-loaded cities; others must be added once in Settings (each
   addition back-fills matching schools immediately). A full PIN→district dataset was not bundled.
6. **Near-real-time only**: the default is a sync every 15 minutes (configurable per source, minimum 1 minute) plus manual
   SYNC NOW. Push notifications from Google Forms (Apps Script trigger → webhook) are not implemented; they can be added
   with a small authenticated webhook that calls the existing sync for that source.
7. **Merging two existing schools** (after both already have IDs) is not in V1; link the sheet rows to the surviving
   school and remove the duplicate row from the sheet.
8. **Follow-ups and multiple teachers** have tables but no UI yet, as agreed for V1.
9. Session storage is in the database; very large deployments with many app instances should keep a single scheduler
   instance (`SYNC_SCHEDULER=false` elsewhere).
10. A Postgres sequence value is consumed even by a failed insert, so School IDs can have gaps. IDs are still unique and
    never change.
