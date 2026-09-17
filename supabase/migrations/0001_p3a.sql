-- TindaBot P3a — cloud backup schema (BLUEPRINT §G P3, "Cloud backup (P3a — decided 2026-09-15)").
--
-- Principles enforced here, not in the client:
--   * events are append-only and write-once by id: INSERT + SELECT only, no UPDATE, no DELETE
--   * records (stores/products/customers) are last-write-wins by the client's updated_at; a stale
--     upsert is silently skipped by lww_guard(); no DELETE anywhere
--   * visibility is by membership (store_members); the owner membership is created by a trigger
--     when a store row is inserted, and clients cannot write store_members at all in P3a
--   * archiving a store is a flag (archived_at) set only through owner-only RPCs — never a delete
--   * every row keeps the full client object verbatim in `body` (byte-exact round trips)
--   * pulls are safe against the commit-order race: `xid` records the INSERTING transaction's
--     id and sync_watermark() reports the lowest still-running transaction, so a client only ever
--     consumes rows whose transactions had already finished (see BLUEPRINT §E7 "Pull windows")
--
-- Apply with `npx supabase db push` (after `npx supabase link`) or paste into the SQL editor.

create sequence if not exists public.record_rev_seq;
create sequence if not exists public.event_seq;

-- ---------------------------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------------------------

create table public.stores (
  id text primary key,
  body jsonb not null,
  updated_at timestamptz not null,
  server_updated_at timestamptz not null default now(),
  server_rev bigint not null default nextval('public.record_rev_seq'),
  created_by uuid not null references auth.users (id),
  archived_at timestamptz
);

create table public.store_members (
  store_id text not null references public.stores (id),
  user_id uuid not null references auth.users (id),
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);

create table public.products (
  id text primary key,
  store_id text not null references public.stores (id),
  body jsonb not null,
  updated_at timestamptz not null,
  server_updated_at timestamptz not null default now(),
  server_rev bigint not null default nextval('public.record_rev_seq'),
  -- transaction that last wrote this row; set by trigger, never by the client (see sync_watermark)
  xid bigint not null default 0
);

create table public.customers (
  id text primary key,
  store_id text not null references public.stores (id),
  body jsonb not null,
  updated_at timestamptz not null,
  server_updated_at timestamptz not null default now(),
  server_rev bigint not null default nextval('public.record_rev_seq'),
  xid bigint not null default 0
);

create table public.events (
  id text primary key,
  store_id text not null references public.stores (id),
  type text not null,
  ts text not null,            -- ISO string with offset, kept verbatim (part of the event's order)
  body jsonb not null,
  -- server-assigned by trigger (never by the client), unique and monotonic per insert
  server_seq bigint not null unique default 0,
  xid bigint not null default 0,
  inserted_at timestamptz not null default now()
);

-- Pull windows filter on xid and page on the row sequence, in that order.
create index products_store_pull on public.products (store_id, xid, server_rev);
create index customers_store_pull on public.customers (store_id, xid, server_rev);
create index events_store_pull on public.events (store_id, xid, server_seq);
create index store_members_user on public.store_members (user_id);

-- ---------------------------------------------------------------------------------------------
-- membership predicates (security definer: read store_members without recursive RLS)
-- ---------------------------------------------------------------------------------------------

create or replace function public.is_member(sid text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.store_members m where m.store_id = sid and m.user_id = auth.uid());
$$;

create or replace function public.is_owner(sid text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.store_members m where m.store_id = sid and m.user_id = auth.uid() and m.role = 'owner');
$$;

-- ---------------------------------------------------------------------------------------------
-- pull safety: transaction id per row + the committed high-water mark
-- ---------------------------------------------------------------------------------------------

-- `xid` on every row below is (pg_current_xact_id()::text)::bigint — the writing transaction's id
-- (xid8, 64-bit, never wraps), taken at write time, before the transaction commits. It is set by
-- the triggers only, so a client can neither choose it nor call it directly.
--
-- The lowest transaction id that is still running. Postgres guarantees every transaction with a
-- LOWER id has already finished (committed and visible, or aborted and gone forever), so a client
-- that only consumes rows with `xid < sync_watermark()` can never step over a row that had not
-- committed yet. Uses pg_current_snapshot(), which does NOT assign an xid to the reading session.
create or replace function public.sync_watermark()
returns bigint
language sql stable
as $$
  select (pg_snapshot_xmin(pg_current_snapshot())::text)::bigint;
$$;

-- ---------------------------------------------------------------------------------------------
-- triggers
-- ---------------------------------------------------------------------------------------------

-- New store rows belong to the caller; clients cannot choose created_by or start archived.
create or replace function public.stores_before_insert()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  new.created_by := auth.uid();
  new.archived_at := null;
  new.server_updated_at := now();
  new.server_rev := nextval('public.record_rev_seq');
  return new;
end;
$$;

-- Owner membership is created by the server (clients have no write access to store_members).
create or replace function public.stores_after_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.store_members (store_id, user_id, role) values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

-- LWW guard for products/customers: a stale updated_at is skipped (RETURN NULL = no update).
create or replace function public.lww_guard()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at <= old.updated_at then
    return null;
  end if;
  new.store_id := old.store_id;
  new.server_updated_at := now();
  new.server_rev := nextval('public.record_rev_seq');
  new.xid := (pg_current_xact_id()::text)::bigint;
  return new;
end;
$$;

-- Same for stores, plus: created_by/archived_at can only change through the RPCs below.
create or replace function public.stores_lww_guard()
returns trigger
language plpgsql
as $$
begin
  if current_setting('tindabot.archive_rpc', true) = '1' then
    -- archive_store / unarchive_store: only the flag changes
    new.body := old.body;
    new.updated_at := old.updated_at;
    new.created_by := old.created_by;
    new.server_updated_at := now();
    new.server_rev := nextval('public.record_rev_seq');
    return new;
  end if;
  if new.updated_at <= old.updated_at then
    return null;
  end if;
  new.created_by := old.created_by;
  new.archived_at := old.archived_at;
  new.server_updated_at := now();
  new.server_rev := nextval('public.record_rev_seq');
  return new;
end;
$$;

create or replace function public.records_before_insert()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at := now();
  new.server_rev := nextval('public.record_rev_seq');
  new.xid := (pg_current_xact_id()::text)::bigint;
  return new;
end;
$$;

-- Events: the server owns server_seq and xid (a client may not choose either; the rest of the
-- row is the client's write-once event).
create or replace function public.events_before_insert()
returns trigger
language plpgsql
as $$
begin
  new.server_seq := nextval('public.event_seq');
  new.xid := (pg_current_xact_id()::text)::bigint;
  new.inserted_at := now();
  return new;
end;
$$;

create trigger events_bi before insert on public.events for each row execute function public.events_before_insert();
create trigger stores_bi before insert on public.stores for each row execute function public.stores_before_insert();
create trigger stores_ai after insert on public.stores for each row execute function public.stores_after_insert();
create trigger stores_bu before update on public.stores for each row execute function public.stores_lww_guard();
create trigger products_bi before insert on public.products for each row execute function public.records_before_insert();
create trigger products_bu before update on public.products for each row execute function public.lww_guard();
create trigger customers_bi before insert on public.customers for each row execute function public.records_before_insert();
create trigger customers_bu before update on public.customers for each row execute function public.lww_guard();

-- ---------------------------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------------------------

create or replace function public.server_time()
returns timestamptz
language sql stable
as $$
  select now();
$$;

-- Owner-only, non-destructive: flips archived_at. Used by "Panatilihin ang nasa phone".
create or replace function public.archive_store(sid text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_owner(sid) then
    raise exception 'not owner' using errcode = '42501';
  end if;
  perform set_config('tindabot.archive_rpc', '1', true);
  update public.stores set archived_at = coalesce(archived_at, now()) where id = sid;
  perform set_config('tindabot.archive_rpc', '0', true);
end;
$$;

create or replace function public.unarchive_store(sid text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_owner(sid) then
    raise exception 'not owner' using errcode = '42501';
  end if;
  perform set_config('tindabot.archive_rpc', '1', true);
  update public.stores set archived_at = null where id = sid;
  perform set_config('tindabot.archive_rpc', '0', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- privileges + RLS (no DELETE grants anywhere; events have no UPDATE grant)
-- ---------------------------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
revoke all on all sequences in schema public from anon, authenticated;

grant select, insert, update on public.stores, public.products, public.customers to authenticated;
grant select, insert on public.events to authenticated;
grant select on public.store_members to authenticated;
grant usage on sequence public.record_rev_seq, public.event_seq to authenticated;
grant execute on function public.is_member(text), public.is_owner(text), public.server_time(), public.sync_watermark(), public.archive_store(text), public.unarchive_store(text) to authenticated;

alter table public.stores enable row level security;
alter table public.store_members enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.events enable row level security;

create policy stores_select on public.stores for select to authenticated using (public.is_member(id));
create policy stores_insert on public.stores for insert to authenticated with check (auth.uid() is not null);
create policy stores_update on public.stores for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));

create policy members_select on public.store_members for select to authenticated using (user_id = auth.uid());

create policy products_select on public.products for select to authenticated using (public.is_member(store_id));
create policy products_insert on public.products for insert to authenticated with check (public.is_member(store_id));
create policy products_update on public.products for update to authenticated using (public.is_member(store_id)) with check (public.is_member(store_id));

create policy customers_select on public.customers for select to authenticated using (public.is_member(store_id));
create policy customers_insert on public.customers for insert to authenticated with check (public.is_member(store_id));
create policy customers_update on public.customers for update to authenticated using (public.is_member(store_id)) with check (public.is_member(store_id));

create policy events_select on public.events for select to authenticated using (public.is_member(store_id));
create policy events_insert on public.events for insert to authenticated with check (public.is_member(store_id));
