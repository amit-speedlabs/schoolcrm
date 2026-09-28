-- 1) Student counts without a grade split (e.g. a "Total Registration" column).
--    total_students stays generated and now includes the ungraded count.
DROP VIEW school_student_totals;
ALTER TABLE student_registrations
  ADD COLUMN ungraded_count INT NOT NULL DEFAULT 0 CHECK (ungraded_count >= 0);
ALTER TABLE student_registrations DROP COLUMN total_students;
ALTER TABLE student_registrations
  ADD COLUMN total_students INT GENERATED ALWAYS AS (grade_3_count + grade_4_count + grade_5_count + grade_6_count
                                                   + grade_7_count + grade_8_count + grade_9_count + grade_10_count
                                                   + ungraded_count) STORED;
CREATE VIEW school_student_totals AS
SELECT school_id,
       sum(grade_3_count)::int  AS grade_3,  sum(grade_4_count)::int  AS grade_4,
       sum(grade_5_count)::int  AS grade_5,  sum(grade_6_count)::int  AS grade_6,
       sum(grade_7_count)::int  AS grade_7,  sum(grade_8_count)::int  AS grade_8,
       sum(grade_9_count)::int  AS grade_9,  sum(grade_10_count)::int AS grade_10,
       sum(ungraded_count)::int AS ungraded,
       sum(total_students)::int AS total_students,
       min(registration_date)   AS first_student_registration_date,
       max(last_synced_at)      AS last_student_sync
FROM student_registrations
WHERE NOT is_superseded
GROUP BY school_id;

-- 2) Per-source row filter: only rows whose column matches are synced, e.g. {"Type": "School"}
ALTER TABLE data_sources ADD COLUMN row_filter JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3) More header aliases seen in real sheets
INSERT INTO field_aliases (alias_norm, canonical_field) VALUES
  ('name','school_name'),
  ('name of school','school_name'),
  ('contact number','coordinator_phone'),
  ('contact no','coordinator_phone'),
  ('dispatch date','kit_drop_date'),
  ('kit dispatch date','kit_drop_date'),
  ('dispatched on','kit_drop_date'),
  ('total registration','total_students'),
  ('total registrations','total_students'),
  ('total registered students','total_students'),
  ('total student registration','total_students'),
  ('no of students','total_students'),
  ('number of students','total_students')
ON CONFLICT (alias_norm) DO NOTHING;
