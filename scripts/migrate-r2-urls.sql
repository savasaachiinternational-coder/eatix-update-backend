-- =====================================================================
-- MIGRATE R2 URLS: personal Cloudflare account -> company Cloudflare account
-- =====================================================================
-- WHAT THIS DOES:
--   Replaces the OLD bucket public URL (pub-....r2.dev) with the NEW one
--   in EVERY text / text[] / jsonb / jsonb[] column of every table,
--   so all existing videos, shorts, posts, avatars, chat voice notes,
--   gallery photos, menu files, etc. keep working after the account move.
--
-- RUN THIS ONLY WHEN (all done first):
--   1) All files are copied to the new bucket (rclone, see migration guide)
--   2) eatix-backend/.env (production server) points to the NEW account
--   3) PM2 was restarted (new uploads now go to the new bucket)
--
-- HOW TO RUN (on the production server):
--   pg_dump "$DATABASE_URL" -Fc -f /tmp/eatix-before-r2-migration.dump   <-- BACKUP FIRST
--   psql "$DATABASE_URL" -f scripts/migrate-r2-urls.sql
--   ($DATABASE_URL = the DATABASE_URL value from your .env)
--
-- NOTES:
--   - Runs as ONE transaction: if anything fails, nothing is changed.
--   - Safe to re-run (idempotent): second run updates 0 rows.
--   - Also works if the new public URL is a custom domain (e.g. https://cdn.example.com).
-- =====================================================================

DO $$
DECLARE
  -- OLD bucket public URL (personal account) - already filled in:
  old_url  text := 'https://pub-1f63b0fb24a74b7b867c1b1334bd643c.r2.dev';

  -- >>> CHANGE THIS to your NEW bucket public URL from the company account: <<<
  new_url  text := 'https://pub-CHANGE-ME.r2.dev';

  like_pat text;
  r        record;
  cast_as  text;
  n        bigint;
  total    bigint := 0;
BEGIN
  IF new_url LIKE '%CHANGE-ME%' THEN
    RAISE EXCEPTION 'ERROR: edit this file first and set new_url to the new bucket public URL';
  END IF;

  like_pat := '%' || old_url || '%';

  FOR r IN
    SELECT c.table_schema, c.table_name, c.column_name, c.udt_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON  t.table_schema = c.table_schema
      AND t.table_name   = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type   = 'BASE TABLE'
      AND c.udt_name IN ('text', 'varchar', 'jsonb', '_jsonb', '_text')
    ORDER BY c.table_name, c.column_name
  LOOP
    -- How to cast the replaced text back to the original column type
    cast_as := CASE r.udt_name
                 WHEN 'text'    THEN 'text'
                 WHEN 'varchar' THEN 'varchar'
                 WHEN 'jsonb'   THEN 'jsonb'
                 WHEN '_jsonb'  THEN 'jsonb[]'
                 WHEN '_text'   THEN 'text[]'
               END;

    EXECUTE format(
      'UPDATE %I.%I SET %I = REPLACE(%I::text, %L, %L)::%s WHERE %I::text LIKE %L',
      r.table_schema, r.table_name, r.column_name,
      r.column_name, old_url, new_url, cast_as,
      r.column_name, like_pat
    );
    GET DIAGNOSTICS n = ROW_COUNT;

    IF n > 0 THEN
      RAISE NOTICE 'UPDATED  %.% -> % row(s)', r.table_name, r.column_name, n;
      total := total + n;
    END IF;
  END LOOP;

  RAISE NOTICE 'DONE. Total rows updated: %', total;
END $$;

-- =====================================================================
-- VERIFICATION: after running the block above, this must print
-- "SCAN COMPLETE - no remaining old URLs".
-- If it lists any column, run the migration block again.
-- =====================================================================
DO $$
DECLARE
  old_url text := 'https://pub-1f63b0fb24a74b7b867c1b1334bd643c.r2.dev';
  r       record;
  n       bigint;
  found   boolean := false;
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON  t.table_schema = c.table_schema
      AND t.table_name   = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type   = 'BASE TABLE'
      AND c.udt_name IN ('text', 'varchar', 'jsonb', '_jsonb', '_text')
    ORDER BY c.table_name, c.column_name
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text LIKE %L',
      r.table_schema, r.table_name, r.column_name, '%' || old_url || '%')
      INTO n;
    IF n > 0 THEN
      RAISE WARNING 'REMAINING OLD URLS: %.% -> % row(s)', r.table_name, r.column_name, n;
      found := true;
    END IF;
  END LOOP;

  IF found THEN
    RAISE EXCEPTION 'Some columns still contain the old URL - run the migration block again.';
  ELSE
    RAISE NOTICE 'SCAN COMPLETE - no remaining old URLs. Migration successful.';
  END IF;
END $$;
