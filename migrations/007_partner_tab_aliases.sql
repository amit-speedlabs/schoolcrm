-- Header spellings used in the partner institution tabs and the SL Team - Direct tab.
INSERT INTO field_aliases (alias_norm, canonical_field) VALUES
  ('name of principal school head','principal_name'),
  ('contact of principal school head','principal_contact'),
  ('principal school head email id','school_email'),
  ('name of coordinating teacher','coordinator_name'),
  ('contact of coordinating teacher','coordinator_phone'),
  ('kit handover date','kit_drop_date'),
  ('date of kit handover','kit_drop_date'),
  ('official school email id','school_email'),
  ('school address google map link','address')
ON CONFLICT (alias_norm) DO NOTHING;
