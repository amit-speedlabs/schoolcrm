-- Every school listed in a kit distribution sheet got exactly 1 kit (rule from 2026-10-10).
-- The sync now writes 1 for kit sheets; this fixes counts already stored.
UPDATE schools SET number_of_kits = 1, updated_at = now(), updated_by = 'migration:009'
WHERE kit_drop_date IS NOT NULL AND number_of_kits IS DISTINCT FROM 1;

-- Per-source switch for the rule (on by default); a sheet where a blank kit date means "not given yet" can turn it off.
ALTER TABLE data_sources ADD COLUMN one_kit_per_school BOOLEAN NOT NULL DEFAULT TRUE;
