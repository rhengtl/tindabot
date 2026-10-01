-- TindaBot P4/P5 additions (decided 2026-10-01). ADDITIONS ONLY: new tables and new functions.
-- Nothing in 0001 is altered or dropped, no existing row is touched, and clients still cannot write
-- store_members directly. Safe to run once in the SQL editor; re-running it is harmless.
--
--   1. ai_quota_hit()  — per-user rate limit for the AI proxy (frontend/api/ai.ts): 30 calls per
--      minute, 300 per day. Called with the caller's own token, so it also proves the caller is a
--      signed-in user. Only the call times are kept (no content), and only for two days.
--   2. Household (P5): the owner makes a one-time invite code; another signed-in person redeems it
--      and becomes a `member` of that store (products/customers/events are already readable and
--      writable by members through the 0001 policies; the store row and archiving stay owner-only).
--      The owner can remove a member; a member can leave.

-- ---------------------------------------------------------------------------------------------
-- 1. AI rate limit
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ai_calls (
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now()
);
create index if not exists ai_calls_user_at on public.ai_calls (user_id, at);
alter table public.ai_calls enable row level security; -- no policies: reachable only through the function below

create or replace function public.ai_quota_hit()
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  last_min int;
  last_day int;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- serialize this user's calls so two parallel requests cannot both slip under the limit
  perform pg_advisory_xact_lock(hashtextextended('ai_quota:' || uid::text, 0));
  delete from public.ai_calls where user_id = uid and at < now() - interval '2 days';
  select count(*) filter (where at > now() - interval '1 minute'), count(*) filter (where at > now() - interval '1 day')
    into last_min, last_day
    from public.ai_calls where user_id = uid;
  if last_min >= 30 or last_day >= 300 then
    return false;
  end if;
  insert into public.ai_calls (user_id) values (uid);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Household: invites and membership
-- ---------------------------------------------------------------------------------------------

create table if not exists public.store_invites (
  code text primary key,
  store_id text not null references public.stores (id),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_by uuid references auth.users (id),
  used_at timestamptz
);
create index if not exists store_invites_store on public.store_invites (store_id);
alter table public.store_invites enable row level security; -- no policies: RPCs only

-- failed redemption attempts, to make guessing codes pointless (10 per hour per user)
create table if not exists public.invite_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now()
);
create index if not exists invite_attempts_user_at on public.invite_attempts (user_id, at);
alter table public.invite_attempts enable row level security;

-- Owner only. A new code replaces any unused code of the same store (the old one stops working).
-- 8 characters from a 31-letter alphabet without look-alikes (no 0/O, 1/I/L), valid 24 hours.
create or replace function public.create_invite(sid text)
returns table (code text, expires_at timestamptz)
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  c text;
  b bytea;
  i int;
begin
  if not public.is_owner(sid) then
    raise exception 'not owner' using errcode = '42501';
  end if;
  if exists (select 1 from public.stores s where s.id = sid and s.archived_at is not null) then
    raise exception 'store archived' using errcode = '42501';
  end if;
  update public.store_invites si set expires_at = now() where si.store_id = sid and si.used_at is null and si.expires_at > now();
  loop
    b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    c := '';
    for i in 0..7 loop
      c := c || substr(alphabet, 1 + (get_byte(b, i) % 31), 1);
    end loop;
    exit when not exists (select 1 from public.store_invites si where si.code = c);
  end loop;
  insert into public.store_invites (code, store_id, created_by, expires_at) values (c, sid, auth.uid(), now() + interval '24 hours');
  return query select c, now() + interval '24 hours';
end;
$$;

-- Any signed-in user. Returns {"store_id": …} or {"error": "invalid" | "too_many" | "own"}.
-- Errors are RETURNED, not raised: a raised error would roll back the failed-attempt row and the
-- limit (10 failed attempts per hour per user) would never count anything.
create or replace function public.join_store(invite text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
  inv public.store_invites%rowtype;
  norm text := upper(regexp_replace(coalesce(invite, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if (select count(*) from public.invite_attempts a where a.user_id = uid and a.at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('error', 'too_many');
  end if;
  select * into inv from public.store_invites si where si.code = norm for update;
  if not found or inv.used_at is not null or inv.expires_at <= now()
     or exists (select 1 from public.stores s where s.id = inv.store_id and s.archived_at is not null) then
    insert into public.invite_attempts (user_id) values (uid);
    return jsonb_build_object('error', 'invalid');
  end if;
  if inv.created_by = uid then
    return jsonb_build_object('error', 'own');
  end if;
  insert into public.store_members (store_id, user_id, role) values (inv.store_id, uid, 'member') on conflict (store_id, user_id) do nothing;
  update public.store_invites si set used_by = uid, used_at = now() where si.code = norm;
  return jsonb_build_object('store_id', inv.store_id);
end;
$$;

-- Members of a store, for any member of it (the owner sees who has access; a member sees the owner).
create or replace function public.list_members(sid text)
returns table (user_id uuid, email text, role text, joined_at timestamptz)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_member(sid) then
    raise exception 'not member' using errcode = '42501';
  end if;
  return query
    select m.user_id, u.email::text, m.role, m.created_at
    from public.store_members m join auth.users u on u.id = m.user_id
    where m.store_id = sid
    order by (m.role = 'owner') desc, m.created_at;
end;
$$;

-- Owner removes a member (never the owner). Only the membership row goes; every entry the member
-- recorded stays in the store.
create or replace function public.remove_member(sid text, member_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_owner(sid) then
    raise exception 'not owner' using errcode = '42501';
  end if;
  delete from public.store_members m where m.store_id = sid and m.user_id = member_id and m.role = 'member';
end;
$$;

-- A member leaves a store (the owner cannot leave their own store; they delete/archive it instead).
create or replace function public.leave_store(sid text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if public.is_owner(sid) then
    raise exception 'owner cannot leave' using errcode = '42501';
  end if;
  delete from public.store_members m where m.store_id = sid and m.user_id = auth.uid() and m.role = 'member';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- privileges (functions only; the new tables have RLS on and no grants)
-- ---------------------------------------------------------------------------------------------

revoke all on public.ai_calls, public.store_invites, public.invite_attempts from anon, authenticated;
revoke all on function public.ai_quota_hit(), public.create_invite(text), public.join_store(text), public.list_members(text), public.remove_member(text, uuid), public.leave_store(text) from public, anon;
grant execute on function public.ai_quota_hit(), public.create_invite(text), public.join_store(text), public.list_members(text), public.remove_member(text, uuid), public.leave_store(text) to authenticated;
