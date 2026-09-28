-- Header spellings used in the live "B2B Registeration" sheet (short grade headers such as "G3" are matched in code).
INSERT INTO field_aliases (alias_norm, canonical_field) VALUES
  ('total registeration','total_students'),
  ('total registerations','total_students'),
  ('total student registeration','total_students'),
  ('date of registeration','registration_date'),
  ('registeration date','registration_date')
ON CONFLICT (alias_norm) DO NOTHING;
