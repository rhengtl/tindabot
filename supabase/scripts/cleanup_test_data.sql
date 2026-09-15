-- TindaBot — remove data created by the automated test users. RUN MANUALLY in the Supabase SQL
-- editor (as the project owner). This is the only mechanism that deletes cloud rows; the app and
-- the tests have no DELETE privilege at all.
--
-- Scope is enforced three ways, all of which must hold for a row to be deleted:
--   1. the store was created by one of the TEST USER EMAILS listed below (never a Google account);
--   2. the store's name starts with 'test-' (every store the test suite creates is named test-<runid>-…);
--   3. the transaction aborts if either check would be violated, so a mistake deletes nothing.
--
-- Edit the emails to match the two users you created for the tests, then run the whole file.

begin;

create temp table _test_users on commit drop as
  select id from auth.users
  where email in ('tindabot-test-a@example.com', 'tindabot-test-b@example.com');

do $$
declare n int;
begin
  select count(*) into n from _test_users;
  if n = 0 then
    raise exception 'no test users matched — nothing deleted';
  end if;
  if exists (select 1 from auth.users u join _test_users t on t.id = u.id where u.email not like 'tindabot-test-%') then
    raise exception 'a matched user does not look like a test user — nothing deleted';
  end if;
end $$;

create temp table _test_stores on commit drop as
  select s.id from public.stores s
  where s.created_by in (select id from _test_users);

do $$
begin
  if exists (select 1 from public.stores s join _test_stores t on t.id = s.id where (s.body->>'name') not like 'test-%') then
    raise exception 'a store owned by a test user is not named test-… — nothing deleted';
  end if;
end $$;

delete from public.events        where store_id in (select id from _test_stores);
delete from public.products      where store_id in (select id from _test_stores);
delete from public.customers     where store_id in (select id from _test_stores);
delete from public.store_members where store_id in (select id from _test_stores);
delete from public.stores        where id in (select id from _test_stores);

-- report
select
  (select count(*) from _test_users)  as test_users,
  (select count(*) from _test_stores) as stores_deleted;

commit;
