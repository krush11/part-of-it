-- Part of It Counter: run this once in Supabase → SQL Editor → New query.
-- Safe to re-run.
--
-- The app talks to Supabase with the public (publishable) key, so the tables
-- are locked away from that key. Everything goes through the functions below:
-- record one tap (for today only), undo your own last tap, and read anonymous
-- tap timings. No email ever leaves the database.

-- ============================================================================
-- Taps: one row per tap. The server turns these into the class count by
-- looking for moments when many different devices tapped together
-- (see lib/consensus.js).
-- ============================================================================

create table if not exists public.poi_taps (
  id      bigserial   primary key,
  -- XLRI roll email: b26032, bi26002, bl26012 … @astra.xlri.ac.in
  email   text        not null
          check (email = lower(email)
                 and email ~ '^b[il]?260(0[1-9]|[1-5][0-9]|60)@astra\.xlri\.ac\.in$'),
  day     date        not null,
  -- sha256 (hex) of the browser's device cookie; lets us count distinct devices
  device  text        not null check (char_length(device) between 16 and 128),
  at      timestamptz not null default now()
);

create index if not exists poi_taps_day_at       on public.poi_taps (day, at);
create index if not exists poi_taps_email_day_at on public.poi_taps (email, day, at);

alter table public.poi_taps enable row level security;
revoke all on table public.poi_taps from anon, authenticated;
revoke all on sequence public.poi_taps_id_seq from anon, authenticated;

-- Only allow writes for "today", give or take a day for time zones.
create or replace function public.poi_assert_today(p_day date)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_day is null or p_day < current_date - 1 or p_day > current_date + 1 then
    raise exception 'day must be today';
  end if;
end;
$$;

-- Record one tap. Returns false (and stores nothing) when it's a double tap
-- (within 600 ms of the student's own previous tap) or the student has hit
-- the daily cap. p_at may be up to 5 s in the past (network delay); anything
-- else is clamped to now.
create or replace function public.poi_tap(p_email text, p_day date, p_device text, p_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_at timestamptz := least(greatest(coalesce(p_at, now()), now() - interval '5 seconds'), now());
begin
  perform public.poi_assert_today(p_day);
  if exists (
    select 1 from public.poi_taps t
     where t.email = v_email and t.day = p_day
       and t.at between v_at - interval '600 milliseconds' and v_at + interval '600 milliseconds'
  ) then
    return false;
  end if;
  if (select count(*) from public.poi_taps t where t.email = v_email and t.day = p_day) >= 400 then
    return false;
  end if;
  insert into public.poi_taps (email, day, device, at) values (v_email, p_day, p_device, v_at);
  return true;
end;
$$;

-- Undo: delete the student's newest tap if it's less than 15 s old.
create or replace function public.poi_untap(p_email text, p_day date)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
begin
  perform public.poi_assert_today(p_day);
  delete from public.poi_taps t
   where t.id = (
     select x.id from public.poi_taps x
      where x.email = v_email and x.day = p_day
      order by x.at desc, x.id desc
      limit 1
   )
   and t.at > now() - interval '15 seconds';
  return found;
end;
$$;

-- All taps of one day, anonymised: [[student, device, at_ms], ...] in time
-- order. "student" is the id of that email's first tap of the day, and
-- "device" the id of that device's first tap, so the numbers are stable all
-- day and reveal nothing. Returned as one JSON value so the result isn't
-- subject to the API's row limit.
create or replace function public.poi_taps_for_day(p_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_array(s.sid, d.did, (extract(epoch from t.at) * 1000)::bigint)
      order by t.at, t.id
    ),
    '[]'::jsonb
  )
  from public.poi_taps t
  join (select email,  min(id) as sid from public.poi_taps where day = p_day group by email)  s on s.email  = t.email
  join (select device, min(id) as did from public.poi_taps where day = p_day group by device) d on d.device = t.device
  where t.day = p_day;
$$;

-- The caller's own anonymous id for a day (null if they haven't tapped yet).
create or replace function public.poi_my_id(p_email text, p_day date)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select min(t.id) from public.poi_taps t
   where t.email = lower(trim(p_email)) and t.day = p_day;
$$;

-- Days before p_before that have taps, newest first: ["2026-11-13", ...]
create or replace function public.poi_tap_days(p_before date, p_limit integer default 14)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(x.d order by x.d desc), '[]'::jsonb)
  from (
    select to_char(t.day, 'YYYY-MM-DD') as d
      from public.poi_taps t
     where t.day < p_before
     group by t.day
     order by t.day desc
     limit least(greatest(coalesce(p_limit, 14), 1), 60)
  ) x;
$$;

-- ============================================================================
-- Target bids: before (or during) the lecture each student calls how many
-- times he'll say it today, as a bracket (0–9, 10–19 … 140–149, 150+). The
-- bracket's lower bound is stored. One bid per student per day, and it can't
-- be changed once placed.
-- ============================================================================

create table if not exists public.poi_bids (
  email  text        not null
         check (email = lower(email)
                and email ~ '^b[il]?260(0[1-9]|[1-5][0-9]|60)@astra\.xlri\.ac\.in$'),
  day    date        not null,
  bid    integer     not null check (bid between 0 and 150 and bid % 10 = 0),
  at     timestamptz not null default now(),
  primary key (email, day)
);

alter table public.poi_bids enable row level security;
revoke all on table public.poi_bids from anon, authenticated;

-- Place a bid. If the student already has one today, that one stays and is
-- returned (no take-backs). Returns the bid on record.
create or replace function public.poi_bid(p_email text, p_day date, p_bid integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  result integer;
begin
  perform public.poi_assert_today(p_day);
  insert into public.poi_bids (email, day, bid) values (v_email, p_day, p_bid)
  on conflict (email, day) do nothing;
  select b.bid into result from public.poi_bids b where b.email = v_email and b.day = p_day;
  return result;
end;
$$;

-- The caller's bid for a day, or null.
create or replace function public.poi_my_bid(p_email text, p_day date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select b.bid from public.poi_bids b where b.email = lower(trim(p_email)) and b.day = p_day;
$$;

-- Anonymous distribution of a day's bids: [[bid, students], ...] ascending.
create or replace function public.poi_bids_for_day(p_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(x.bid, x.n) order by x.bid), '[]'::jsonb)
  from (select b.bid, count(*)::integer as n from public.poi_bids b where b.day = p_day group by b.bid) x;
$$;

revoke execute on function public.poi_bid(text, date, integer) from public;
revoke execute on function public.poi_my_bid(text, date) from public;
revoke execute on function public.poi_bids_for_day(date) from public;
grant execute on function public.poi_bid(text, date, integer) to anon, authenticated;
grant execute on function public.poi_my_bid(text, date) to anon, authenticated;
grant execute on function public.poi_bids_for_day(date) to anon, authenticated;

-- ============================================================================
-- Legacy: before the tap-based counter, each student kept their own count and
-- the class number was the mode. The table is kept so old days still show in
-- history; nothing writes to it any more.
-- ============================================================================

create table if not exists public.part_of_it_counts (
  email      text        not null
             check (char_length(email) <= 254
                    and email = lower(email)
                    and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  day        date        not null,
  count      integer     not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (email, day)
);

alter table public.part_of_it_counts enable row level security;
revoke all on table public.part_of_it_counts from anon, authenticated;

create or replace function public.poi_daily_modes(p_up_to date, p_limit integer default 31)
returns table (date text, mode integer, students integer)
language sql
stable
security definer
set search_path = ''
as $$
  select to_char(c.day, 'YYYY-MM-DD'),
         mode() within group (order by c.count desc),
         count(*)::integer
    from public.part_of_it_counts c
   where c.day <= p_up_to
   group by c.day
   order by c.day desc
   limit least(greatest(coalesce(p_limit, 31), 1), 60);
$$;

-- Old write/read functions are gone: the table is read-only history now.
drop function if exists public.poi_join(text, date);
drop function if exists public.poi_increment(text, date);
drop function if exists public.poi_decrement(text, date);
drop function if exists public.poi_distribution(date);

-- ============================================================================
-- Permissions
-- ============================================================================

revoke execute on function public.poi_assert_today(date) from public, anon, authenticated;

revoke execute on function public.poi_tap(text, date, text, timestamptz) from public;
revoke execute on function public.poi_untap(text, date) from public;
revoke execute on function public.poi_taps_for_day(date) from public;
revoke execute on function public.poi_my_id(text, date) from public;
revoke execute on function public.poi_tap_days(date, integer) from public;
revoke execute on function public.poi_daily_modes(date, integer) from public;

grant execute on function public.poi_tap(text, date, text, timestamptz) to anon, authenticated;
grant execute on function public.poi_untap(text, date) to anon, authenticated;
grant execute on function public.poi_taps_for_day(date) to anon, authenticated;
grant execute on function public.poi_my_id(text, date) to anon, authenticated;
grant execute on function public.poi_tap_days(date, integer) to anon, authenticated;
grant execute on function public.poi_daily_modes(date, integer) to anon, authenticated;
