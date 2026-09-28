-- A school that was given a kit counts as 1 kit unless a number of kits is entered.
-- A trigger covers every path (sheet sync, manual edit, import); an explicit number, including 0, is kept.
CREATE OR REPLACE FUNCTION schools_default_kit_count() RETURNS trigger AS $$
BEGIN
  IF NEW.kit_drop_date IS NOT NULL AND NEW.number_of_kits IS NULL THEN
    NEW.number_of_kits := 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schools_default_kit_count
  BEFORE INSERT OR UPDATE OF kit_drop_date, number_of_kits ON schools
  FOR EACH ROW EXECUTE FUNCTION schools_default_kit_count();

UPDATE schools SET number_of_kits = 1 WHERE kit_drop_date IS NOT NULL AND number_of_kits IS NULL;

-- More CITY -> DISTRICT rows (Bihar district towns, plus Nashik).
INSERT INTO geo_city_district (state, city, district) VALUES
  ('Bihar','Siwan','Siwan'),
  ('Bihar','Danapur','Patna'),
  ('Bihar','Gaya','Gaya'),
  ('Bihar','Bodh Gaya','Gaya'),
  ('Bihar','Bhagalpur','Bhagalpur'),
  ('Bihar','Muzaffarpur','Muzaffarpur'),
  ('Bihar','Darbhanga','Darbhanga'),
  ('Bihar','Purnia','Purnia'),
  ('Bihar','Begusarai','Begusarai'),
  ('Bihar','Chapra','Saran'),
  ('Bihar','Chhapra','Saran'),
  ('Bihar','Hajipur','Vaishali'),
  ('Bihar','Arrah','Bhojpur'),
  ('Bihar','Ara','Bhojpur'),
  ('Bihar','Bettiah','West Champaran'),
  ('Bihar','Motihari','East Champaran'),
  ('Bihar','Sasaram','Rohtas'),
  ('Bihar','Dehri','Rohtas'),
  ('Bihar','Katihar','Katihar'),
  ('Bihar','Munger','Munger'),
  ('Bihar','Bihar Sharif','Nalanda'),
  ('Bihar','Biharsharif','Nalanda'),
  ('Bihar','Samastipur','Samastipur'),
  ('Bihar','Sitamarhi','Sitamarhi'),
  ('Bihar','Madhubani','Madhubani'),
  ('Bihar','Gopalganj','Gopalganj'),
  ('Bihar','Buxar','Buxar'),
  ('Bihar','Aurangabad','Aurangabad'),
  ('Bihar','Jehanabad','Jehanabad'),
  ('Bihar','Nawada','Nawada'),
  ('Bihar','Saharsa','Saharsa'),
  ('Bihar','Kishanganj','Kishanganj'),
  ('Bihar','Araria','Araria'),
  ('Bihar','Forbesganj','Araria'),
  ('Bihar','Supaul','Supaul'),
  ('Bihar','Madhepura','Madhepura'),
  ('Bihar','Khagaria','Khagaria'),
  ('Bihar','Lakhisarai','Lakhisarai'),
  ('Bihar','Sheikhpura','Sheikhpura'),
  ('Bihar','Jamui','Jamui'),
  ('Bihar','Banka','Banka'),
  ('Bihar','Bhabua','Kaimur'),
  ('Bihar','Arwal','Arwal'),
  ('Bihar','Sheohar','Sheohar'),
  ('Maharashtra','Nashik','Nashik')
ON CONFLICT DO NOTHING;

-- Fill schools still missing a district from the lookup (never touches a sheet or manual district).
UPDATE schools s SET district = g.district, district_origin = 'LOOKUP', updated_at = now()
  FROM geo_city_district g
 WHERE s.district IS NULL AND lower(s.state) = lower(g.state) AND lower(s.city) = lower(g.city);
