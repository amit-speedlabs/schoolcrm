-- one_kit_per_school becomes three-way: TRUE = this tab is a kit tab (every school listed got 1 kit, even with no
-- kit date or count column), FALSE = never, NULL = decide from the columns (a kit date or kit count column).
ALTER TABLE data_sources ALTER COLUMN one_kit_per_school DROP NOT NULL, ALTER COLUMN one_kit_per_school DROP DEFAULT;
UPDATE data_sources SET one_kit_per_school = NULL WHERE one_kit_per_school;
-- The kit tabs Amit listed (2026-10-10: "each school in kit distribution sheet has 1 kit"); SL Team - AEM has no kit column.
UPDATE data_sources SET one_kit_per_school = TRUE
WHERE lower(trim(sheet_name)) IN ('sl team - aem', 'sl team - direct', 'flora institute of technology', 'shivaji university',
  'indala college of engineering', 'school sales kit');
