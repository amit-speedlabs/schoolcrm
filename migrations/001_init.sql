-- GLF AI Olympiad 2026 CRM - initial schema (PostgreSQL 13+ / Supabase compatible)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- User Master (also the Sales SPOC master). access_role controls CRM login:
--   ADMIN, MANAGEMENT  -> can log in
--   NONE               -> listed in User Master (e.g. Sales SPOC) but no login
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  user_id        SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT,
  team           TEXT,
  role           TEXT,                          -- job role, e.g. 'Sales SPOC'
  access_role    TEXT NOT NULL DEFAULT 'NONE' CHECK (access_role IN ('ADMIN','MANAGEMENT','NONE')),
  state          TEXT,
  city           TEXT,
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  aliases        TEXT[] NOT NULL DEFAULT '{}',  -- alternate spellings seen in sheets
  password_hash  TEXT,
  created_via    TEXT NOT NULL DEFAULT 'MANUAL', -- MANUAL | SYNC | BOOTSTRAP
  is_demo        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------------
-- Channel & Partner masters (never hard-coded; admin-managed)
-- ---------------------------------------------------------------------------
CREATE TABLE channels (
  channel_id   SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  aliases      TEXT[] NOT NULL DEFAULT '{}',
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_via  TEXT NOT NULL DEFAULT 'MANUAL',
  is_demo      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX channels_name_uq ON channels (lower(name));

CREATE TABLE partners (
  partner_id   SERIAL PRIMARY KEY,
  channel_id   INT REFERENCES channels(channel_id),
  name         TEXT NOT NULL,
  description  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_via  TEXT NOT NULL DEFAULT 'MANUAL',
  is_demo      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partners_name_uq ON partners (coalesce(channel_id, 0), lower(name));

-- ---------------------------------------------------------------------------
-- Integration layer: data sources, header mapping, sync logs
-- ---------------------------------------------------------------------------
CREATE TABLE data_sources (
  source_id              SERIAL PRIMARY KEY,
  source_name            TEXT NOT NULL,
  adapter                TEXT NOT NULL DEFAULT 'google' CHECK (adapter IN ('google','fixture')),
  spreadsheet_id         TEXT NOT NULL,
  sheet_name             TEXT NOT NULL,
  source_type            TEXT NOT NULL CHECK (source_type IN
                           ('SCHOOL_MASTER','SCHOOL_REGISTRATION','STUDENT_REGISTRATION','KIT_DISTRIBUTION','COMBINED_REGISTRATION')),
  status                 TEXT NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED','DISABLED')),
  connection_status      TEXT NOT NULL DEFAULT 'NOT_SYNCED' CHECK (connection_status IN ('NOT_SYNCED','CONNECTED','SYNC_ERROR','SYNCING')),
  sync_frequency_minutes INT NOT NULL DEFAULT 15 CHECK (sync_frequency_minutes >= 1),
  header_row             INT NOT NULL DEFAULT 1,
  date_format            TEXT NOT NULL DEFAULT 'DMY' CHECK (date_format IN ('DMY','MDY','YMD')),
  column_mapping         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- per-source overrides: {"Sheet Header": "canonical_field"}
  writeback_enabled      BOOLEAN NOT NULL DEFAULT FALSE,     -- write School ID (and District) back to the sheet
  student_mode           TEXT NOT NULL DEFAULT 'LATEST' CHECK (student_mode IN ('LATEST','SUM')),
  form_url               TEXT,
  is_demo                BOOLEAN NOT NULL DEFAULT FALSE,
  last_sync              TIMESTAMPTZ,   -- last attempt
  last_successful_sync   TIMESTAMPTZ,
  last_error             TEXT,
  consecutive_failures   INT NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Global header alias dictionary. alias_norm is the header lower-cased with
-- punctuation/whitespace collapsed (see src/sync/mapping.js normHeader()).
CREATE TABLE field_aliases (
  alias_norm       TEXT PRIMARY KEY,
  canonical_field  TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sync_logs (
  sync_id       SERIAL PRIMARY KEY,
  source_id     INT NOT NULL REFERENCES data_sources(source_id) ON DELETE CASCADE,
  triggered_by  TEXT NOT NULL,     -- 'scheduler' | 'user:<id>' | 'retry' | 'test'
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED')),
  rows_read     INT NOT NULL DEFAULT 0,
  rows_created  INT NOT NULL DEFAULT 0,
  rows_updated  INT NOT NULL DEFAULT 0,
  rows_unchanged INT NOT NULL DEFAULT 0,
  rows_flagged  INT NOT NULL DEFAULT 0,
  rows_errored  INT NOT NULL DEFAULT 0,
  writeback_count INT NOT NULL DEFAULT 0,
  message       TEXT,
  unmapped_headers TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX sync_logs_source_idx ON sync_logs (source_id, started_at DESC);

CREATE TABLE sync_row_issues (
  issue_id     SERIAL PRIMARY KEY,
  sync_id      INT NOT NULL REFERENCES sync_logs(sync_id) ON DELETE CASCADE,
  source_row   INT,
  severity     TEXT NOT NULL CHECK (severity IN ('ERROR','WARNING')),
  field        TEXT,
  message      TEXT NOT NULL,
  raw_value    TEXT
);

-- ---------------------------------------------------------------------------
-- School Master. school_id is generated once and never changes.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE school_id_seq START 1;

CREATE TABLE schools (
  school_id          TEXT PRIMARY KEY DEFAULT ('SCH' || lpad(nextval('school_id_seq')::text, 6, '0'))
                       CHECK (school_id ~ '^SCH[0-9]{6,}$'),
  school_name        TEXT NOT NULL CHECK (length(trim(school_name)) > 0),
  city               TEXT,
  district           TEXT,
  address            TEXT,
  pin_code           TEXT CHECK (pin_code IS NULL OR pin_code ~ '^[1-9][0-9]{5}$'),
  state              TEXT,
  board              TEXT,
  principal_name     TEXT,
  principal_contact  TEXT,
  school_email       TEXT,
  coordinator_name   TEXT,
  coordinator_phone  TEXT,
  -- Kit (from School Master; kit_given is derived, never entered)
  kit_drop_date      DATE,
  number_of_kits     INT CHECK (number_of_kits IS NULL OR number_of_kits >= 0),
  kit_given          BOOLEAN GENERATED ALWAYS AS (kit_drop_date IS NOT NULL) STORED,
  channel_id         INT REFERENCES channels(channel_id),
  partner_id         INT REFERENCES partners(partner_id),
  sales_spoc_id      INT REFERENCES users(user_id),
  channel_raw        TEXT,   -- value exactly as it appeared in the sheet
  sales_spoc_raw     TEXT,
  -- School registration (separate from student registration)
  school_registered      BOOLEAN NOT NULL DEFAULT FALSE,
  registration_date      DATE,
  registration_source    TEXT,
  registration_form      TEXT,
  last_registration_sync TIMESTAMPTZ,
  -- Lineage / audit
  source             TEXT NOT NULL DEFAULT 'MANUAL',  -- MANUAL | GOOGLE_SHEETS | DEMO
  source_id          INT REFERENCES data_sources(source_id) ON DELETE SET NULL,
  source_sheet       TEXT,
  source_row         INT,
  last_synced_at     TIMESTAMPTZ,
  district_origin    TEXT,  -- SHEET | LOOKUP | MANUAL
  is_demo            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         TEXT,
  updated_by         TEXT
);
CREATE INDEX schools_geo_idx ON schools (state, district, city);
CREATE INDEX schools_channel_idx ON schools (channel_id, partner_id);
CREATE INDEX schools_spoc_idx ON schools (sales_spoc_id);

-- Contacts (principal / coordinator today; multiple teachers later)
CREATE TABLE school_contacts (
  contact_id    SERIAL PRIMARY KEY,
  school_id     TEXT NOT NULL REFERENCES schools(school_id) ON DELETE CASCADE,
  contact_type  TEXT NOT NULL CHECK (contact_type IN ('PRINCIPAL','COORDINATOR','TEACHER','OTHER')),
  name          TEXT,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  subject       TEXT,
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  source        TEXT NOT NULL DEFAULT 'MANUAL',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One synced primary principal/coordinator per school (teachers are unrestricted)
CREATE UNIQUE INDEX school_contacts_primary_uq ON school_contacts (school_id, contact_type)
  WHERE is_primary AND contact_type IN ('PRINCIPAL','COORDINATOR');

-- Grade-wise student registrations (one row per source row / form response)
CREATE TABLE student_registrations (
  registration_id   SERIAL PRIMARY KEY,
  school_id         TEXT NOT NULL REFERENCES schools(school_id) ON DELETE CASCADE,
  registration_date DATE,
  grade_3_count  INT NOT NULL DEFAULT 0 CHECK (grade_3_count  >= 0),
  grade_4_count  INT NOT NULL DEFAULT 0 CHECK (grade_4_count  >= 0),
  grade_5_count  INT NOT NULL DEFAULT 0 CHECK (grade_5_count  >= 0),
  grade_6_count  INT NOT NULL DEFAULT 0 CHECK (grade_6_count  >= 0),
  grade_7_count  INT NOT NULL DEFAULT 0 CHECK (grade_7_count  >= 0),
  grade_8_count  INT NOT NULL DEFAULT 0 CHECK (grade_8_count  >= 0),
  grade_9_count  INT NOT NULL DEFAULT 0 CHECK (grade_9_count  >= 0),
  grade_10_count INT NOT NULL DEFAULT 0 CHECK (grade_10_count >= 0),
  total_students INT GENERATED ALWAYS AS (grade_3_count + grade_4_count + grade_5_count + grade_6_count
                                        + grade_7_count + grade_8_count + grade_9_count + grade_10_count) STORED,
  is_superseded  BOOLEAN NOT NULL DEFAULT FALSE,  -- older response replaced by a newer one (student_mode = LATEST)
  source         TEXT NOT NULL DEFAULT 'MANUAL',
  source_id      INT REFERENCES data_sources(source_id) ON DELETE SET NULL,
  source_sheet   TEXT,
  source_row     INT,
  last_synced_at TIMESTAMPTZ,
  is_demo        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     TEXT,
  updated_by     TEXT
);
CREATE UNIQUE INDEX student_reg_source_row_uq ON student_registrations (source_id, source_row) WHERE source_id IS NOT NULL;
CREATE INDEX student_reg_school_idx ON student_registrations (school_id) WHERE NOT is_superseded;

-- Effective grade-wise totals per school (only current, non-superseded rows)
CREATE VIEW school_student_totals AS
SELECT school_id,
       sum(grade_3_count)::int  AS grade_3,  sum(grade_4_count)::int  AS grade_4,
       sum(grade_5_count)::int  AS grade_5,  sum(grade_6_count)::int  AS grade_6,
       sum(grade_7_count)::int  AS grade_7,  sum(grade_8_count)::int  AS grade_8,
       sum(grade_9_count)::int  AS grade_9,  sum(grade_10_count)::int AS grade_10,
       sum(total_students)::int AS total_students,
       min(registration_date)   AS first_student_registration_date,
       max(last_synced_at)      AS last_student_sync
FROM student_registrations
WHERE NOT is_superseded
GROUP BY school_id;

-- Row identity & change detection for every synced sheet row
CREATE TABLE source_rows (
  source_id     INT NOT NULL REFERENCES data_sources(source_id) ON DELETE CASCADE,
  row_key       TEXT NOT NULL,        -- 'id:SCH000001' once the sheet carries the ID, else 'row:<n>'
  source_row    INT NOT NULL,
  row_hash      TEXT NOT NULL,
  school_id     TEXT REFERENCES schools(school_id) ON DELETE SET NULL,
  state         TEXT NOT NULL DEFAULT 'LINKED' CHECK (state IN ('LINKED','PENDING_REVIEW','REJECTED','ERROR')),
  reviewed      BOOLEAN NOT NULL DEFAULT FALSE,  -- link confirmed by an admin in duplicate review
  raw           JSONB NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, row_key)
);

-- Potential duplicates / unmatched rows awaiting admin review
CREATE TABLE duplicate_reviews (
  review_id            SERIAL PRIMARY KEY,
  source_id            INT REFERENCES data_sources(source_id) ON DELETE CASCADE,
  source_row           INT,
  row_key              TEXT,
  kind                 TEXT NOT NULL CHECK (kind IN ('POSSIBLE_DUPLICATE','UNMATCHED')),
  incoming             JSONB NOT NULL,
  candidates           JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{school_id, school_name, city, score, reasons[]}]
  status               TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','LINKED','CREATED_NEW','DISMISSED')),
  resolved_school_id   TEXT REFERENCES schools(school_id) ON DELETE SET NULL,
  resolved_by          TEXT,
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX duplicate_reviews_open_uq ON duplicate_reviews (source_id, row_key) WHERE status = 'OPEN';

-- ---------------------------------------------------------------------------
-- Audit trail (manual edits + sync changes)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  audit_id     BIGSERIAL PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,          -- CREATE | UPDATE | DELETE | MERGE | LINK
  field        TEXT,
  old_value    TEXT,
  new_value    TEXT,
  changed_by   TEXT NOT NULL,          -- 'user:<id> <email>' or 'sync:<source_id>'
  change_source TEXT NOT NULL DEFAULT 'MANUAL',
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_logs (entity_type, entity_id, changed_at DESC);

-- ---------------------------------------------------------------------------
-- Geography helper: CITY -> DISTRICT lookup (sheets do not carry District)
-- ---------------------------------------------------------------------------
CREATE TABLE geo_city_district (
  state     TEXT NOT NULL,
  city      TEXT NOT NULL,
  district  TEXT NOT NULL,
  PRIMARY KEY (state, city)
);

-- ---------------------------------------------------------------------------
-- FUTURE (not used by V1 UI): follow-ups. Structure only.
-- ---------------------------------------------------------------------------
CREATE TABLE follow_ups (
  follow_up_id      SERIAL PRIMARY KEY,
  school_id         TEXT NOT NULL REFERENCES schools(school_id) ON DELETE CASCADE,
  contact_id        INT REFERENCES school_contacts(contact_id) ON DELETE SET NULL,
  follow_up_date    DATE,
  follow_up_by      INT REFERENCES users(user_id),
  interaction_type  TEXT,
  outcome           TEXT,
  next_follow_up    DATE,
  remarks           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        TEXT,
  updated_by        TEXT
);

CREATE TABLE app_settings (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);
