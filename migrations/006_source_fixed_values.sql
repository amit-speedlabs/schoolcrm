-- Values applied to every row of a source, e.g. {"channel": "Institutions", "partner": "Shivaji University"}.
-- They override the sheet's own column for that field.
ALTER TABLE data_sources ADD COLUMN fixed_values JSONB NOT NULL DEFAULT '{}'::jsonb;
