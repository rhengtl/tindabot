-- TindaBot — remove data created by the automated test users. RUN MANUALLY in the Supabase SQL
-- editor, as the project owner (the editor's default `postgres` role — NOT "run as user" / with RLS:
-- that role cannot see auth.users, and the script then stops with a message). This is the only
-- mechanism that deletes cloud rows; the app and the tests have no DELETE privilege at all.
--
-- Scope is enforced three ways, all of which must hold for a row to be deleted:
--   1. the store was created by one of the TEST USER EMAILS listed below (never a Google account);
--   2. the store's name starts with 'test-' (every store the test suite creates is named test-<runid>-…);
--   3. everything runs in ONE block, so if either check fails nothing at all is deleted.
-- Also removed: the test users' own AI call log and failed-invite rows (migration 0002), and any
-- invites of the test stores. Stores of real accounts are never touched, even where a test user
-- recorded something in them as a household member.
--
-- Why one DO block (2026-10-07): the earlier version kept the ids in temporary tables across several
-- statements; the SQL editor does not always run those statements on one connection, so a later
-- statement failed with `relation "_test_users" does not exist`. Variables inside a single block
-- cannot go missing that way.
--
-- Edit the emails to match the two users you created for the tests, then run the whole file. The
-- result is reported as NOTICE lines in the editor's output.

do $$
declare
  -- every variable is v_-prefixed: a bare `stores` collided with the table in `delete from public.stores`
  test_emails constant text[] := array['tindabot-test-a@example.com', 'tindabot-test-b@example.com'];
  v_users uuid[];
  v_stores text[];
  n_events int := 0;
  n_products int := 0;
  n_customers int := 0;
  n_members int := 0;
  n_invites int := 0;
  n_stores int := 0;
  n_ai int := 0;
  n_attempts int := 0;
begin
  if not has_table_privilege('auth.users', 'select') then
    raise exception 'run this as the project owner (the SQL editor''s default postgres role), not as a user / with RLS — nothing deleted';
  end if;

  select array_agg(id) into v_users from auth.users where email = any (test_emails);
  if v_users is null then
    raise exception 'no test users matched — nothing deleted';
  end if;
  if exists (select 1 from auth.users u where u.id = any (v_users) and u.email not like 'tindabot-test-%') then
    raise exception 'a matched user does not look like a test user — nothing deleted';
  end if;

  select coalesce(array_agg(s.id), '{}') into v_stores from public.stores s where s.created_by = any (v_users);
  if exists (select 1 from public.stores s where s.id = any (v_stores) and coalesce(s.body->>'name', '') not like 'test-%') then
    raise exception 'a store owned by a test user is not named test-… — nothing deleted';
  end if;

  -- migration 0002 tables, when present (invites reference stores, so they go first)
  if to_regclass('public.store_invites') is not null then
    delete from public.store_invites where store_id = any (v_stores) or created_by = any (v_users);
    get diagnostics n_invites = row_count;
  end if;
  if to_regclass('public.ai_calls') is not null then
    delete from public.ai_calls where user_id = any (v_users);
    get diagnostics n_ai = row_count;
  end if;
  if to_regclass('public.invite_attempts') is not null then
    delete from public.invite_attempts where user_id = any (v_users);
    get diagnostics n_attempts = row_count;
  end if;

  delete from public.events where store_id = any (v_stores);
  get diagnostics n_events = row_count;
  delete from public.products where store_id = any (v_stores);
  get diagnostics n_products = row_count;
  delete from public.customers where store_id = any (v_stores);
  get diagnostics n_customers = row_count;
  delete from public.store_members where store_id = any (v_stores);
  get diagnostics n_members = row_count;
  delete from public.stores where id = any (v_stores);
  get diagnostics n_stores = row_count;

  raise notice 'test users: %, stores deleted: %, events: %, products: %, customers: %, memberships: %, invites: %, AI call log rows: %, failed-invite rows: %',
    array_length(v_users, 1), n_stores, n_events, n_products, n_customers, n_members, n_invites, n_ai, n_attempts;
end $$;

-- what is left of the test users' stores (expect 0)
select count(*) as test_user_stores_left
from public.stores s
join auth.users u on u.id = s.created_by
where u.email like 'tindabot-test-%';
