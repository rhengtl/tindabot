-- TindaBot — OPTIONAL helper for the online integration suite. NOT part of the migrations;
-- apply by hand in the SQL editor only while validating, then drop it with the statement at the
-- bottom. `npx supabase db push` never installs this file.
--
-- Why it exists: PostgREST runs every request in its own transaction, so a client cannot hold a
-- transaction open on purpose. The pull-window design is specifically about rows whose
-- transaction has NOT committed yet, and the only honest way to reproduce that on the real
-- database is a request that writes, then waits, then commits. That is all this does.
--
-- Safety: invoker rights (RLS applies to the insert exactly as for the app), member-only,
-- writes nothing but an ordinary event row, and the wait is capped at 3 s (below the default
-- statement timeout). It cannot delete or update anything. While it sleeps it holds the global
-- watermark down, which delays — never loses — other clients' pulls; that is the effect under test.
-- The suite skips the tests that need it when the function is absent.

create or replace function public.test_slow_insert_event(ev jsonb, hold_ms integer)
returns table (server_seq bigint, xid bigint)
language plpgsql
as $$
declare
  sid text := ev->>'store_id';
begin
  if hold_ms is null or hold_ms < 0 or hold_ms > 3000 then
    raise exception 'hold_ms must be 0..3000';
  end if;
  if not public.is_member(sid) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  insert into public.events (id, store_id, type, ts, body)
  values (ev->>'id', sid, ev->>'type', ev->>'ts', ev)
  on conflict (id) do nothing;
  perform pg_sleep(hold_ms / 1000.0);
  return query select e.server_seq, e.xid from public.events e where e.id = ev->>'id';
end;
$$;

revoke all on function public.test_slow_insert_event(jsonb, integer) from public, anon;
grant execute on function public.test_slow_insert_event(jsonb, integer) to authenticated;

-- To remove after validation:
-- drop function public.test_slow_insert_event(jsonb, integer);
