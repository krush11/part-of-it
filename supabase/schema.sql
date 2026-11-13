-- Part of It Counter: run this in Supabase → SQL Editor → New query.
-- Safe to re-run.
--
-- How counting works
-- ------------------
-- Every tap is stored with its time. When the professor says "part of it",
-- honest students tap within a few seconds of each other, so the class total
-- is the number of moments where enough *different* students tapped together:
--
--   * Walk through today's taps in time order. For each tap that isn't part of
--     an already-counted moment, look at the next WINDOW seconds.
--   * If at least QUORUM different students tapped in that window, it's one
--     confirmed "part of it", and all taps in the window are used up.
--   * Otherwise the tap is ignored, and the next tap is tried.
--
-- QUORUM = max(2, 30% of the students who tapped within 10 minutes of that
-- moment). It's 1 only if a single student has tapped all day, so solo
-- testing still works. Results of this design:
--   * Students who never tap are ignored entirely.
--   * One person spamming the button never creates a moment on their own, and
--     tapping many times inside a real moment still counts once.
--   * A small group of pranksters can't fake moments in a class large enough
--     that 30% is more than their group.
--   * Late joiners don't matter: past moments stay counted.
-- Each student is also limited to one tap per 2 seconds and 300 taps a day.
--
-- Security: the app uses the public (publishable) key. The taps table is
-- locked away from that key; it can only call the functions below.

create table if not exists public.part_of_it_taps (
  id    bigint generated always as identity primary key,
  email text        not null
        check (char_length(email) <= 254
               and email = lower(email)
               and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  day   date        not null,
  at    timestamptz not null default now()
);
create index if not exists part_of_it_taps_day_at on public.part_of_it_taps (day, at);
create index if not exists part_of_it_taps_email_day on public.part_of_it_taps (email, day, at);

alter table public.part_of_it_taps enable row level security;
revoke all on table public.part_of_it_taps from anon, authenticated;

-- Functions from the earlier mode-based version.
drop function if exists public.poi_join(text, date);
drop function if exists public.poi_daily_modes(date, integer);
drop function if exists public.poi_distribution(date);
-- The old per-student totals table isn't used anymore. Its counts have no tap
-- times, so they can't be carried over. Uncomment to delete it:
-- drop table if exists public.part_of_it_counts;

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

create or replace function public.poi_my_count(p_email text, p_day date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.part_of_it_taps t
   where t.email = lower(trim(p_email)) and t.day = p_day;
$$;

create or replace function public.poi_increment(p_email text, p_day date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_last  timestamptz;
  v_count integer;
begin
  perform public.poi_assert_today(p_day);
  -- One student's taps are handled one at a time, so double-clicks can't race.
  perform pg_advisory_xact_lock(hashtext('poi:' || v_email));

  select max(t.at), count(*) into v_last, v_count
    from public.part_of_it_taps t
   where t.email = v_email and t.day = p_day;

  -- Ignore taps within 2 seconds of this student's last one, and cap the day.
  if (v_last is null or now() - v_last >= interval '2 seconds') and v_count < 300 then
    insert into public.part_of_it_taps (email, day) values (v_email, p_day);
    v_count := v_count + 1;
  end if;
  return v_count;
end;
$$;

-- Undo removes the student's most recent tap.
create or replace function public.poi_decrement(p_email text, p_day date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
begin
  perform public.poi_assert_today(p_day);
  delete from public.part_of_it_taps
   where id = (select t.id from public.part_of_it_taps t
                where t.email = v_email and t.day = p_day
                order by t.at desc, t.id desc limit 1);
  return public.poi_my_count(v_email, p_day);
end;
$$;

-- The class total for a day (see "How counting works" at the top).
--   total:  confirmed "part of it" moments
--   active: students with at least one tap that day
--   quorum: students needed to confirm a moment right now
create or replace function public.poi_summary(p_day date)
returns table (total integer, active integer, quorum integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_window   constant interval := interval '7 seconds';   -- how far apart one moment's taps can be
  c_recent   constant interval := interval '10 minutes';  -- who counts as "present" for the quorum
  c_fraction constant numeric  := 0.3;                    -- share of present students needed
  r          record;
  v_total    integer := 0;
  v_until    timestamptz := '-infinity';
  v_active   integer;
  v_near     integer;
  v_present  integer;
  v_quorum   integer;
begin
  select count(distinct t.email)::integer into v_active
    from public.part_of_it_taps t where t.day = p_day;

  for r in
    select t.at from public.part_of_it_taps t where t.day = p_day order by t.at, t.id
  loop
    continue when r.at <= v_until;  -- already part of a counted moment

    select count(distinct t.email)::integer into v_near
      from public.part_of_it_taps t
     where t.day = p_day and t.at >= r.at and t.at <= r.at + c_window;

    if v_active <= 1 then
      v_quorum := 1;
    else
      select count(distinct t.email)::integer into v_present
        from public.part_of_it_taps t
       where t.day = p_day and t.at between r.at - c_recent and r.at + c_recent;
      v_quorum := greatest(2, ceil(c_fraction * v_present)::integer);
    end if;

    if v_near >= v_quorum then
      v_total := v_total + 1;
      v_until := r.at + c_window;
    end if;
  end loop;

  -- Quorum as of now, for display.
  if v_active <= 1 then
    v_quorum := 1;
  else
    select count(distinct t.email)::integer into v_present
      from public.part_of_it_taps t
     where t.day = p_day and t.at >= now() - c_recent;
    v_quorum := greatest(2, ceil(c_fraction * v_present)::integer);
  end if;

  return query select v_total, v_active, v_quorum;
end;
$$;

-- Today's distribution: each tap count, how many students have it, and their
-- emails. Students who haven't tapped don't appear.
create or replace function public.poi_distribution(p_day date)
returns table (count integer, students integer, emails text[])
language sql
stable
security definer
set search_path = ''
as $$
  select s.n, count(*)::integer, array_agg(s.email order by s.email)
    from (select t.email, count(*)::integer as n
            from public.part_of_it_taps t
           where t.day = p_day
           group by t.email) s
   group by s.n
   order by s.n desc;
$$;

revoke execute on function public.poi_assert_today(date) from public, anon, authenticated;
revoke execute on function public.poi_my_count(text, date) from public;
revoke execute on function public.poi_increment(text, date) from public;
revoke execute on function public.poi_decrement(text, date) from public;
revoke execute on function public.poi_summary(date) from public;
revoke execute on function public.poi_distribution(date) from public;
grant execute on function public.poi_my_count(text, date) to anon, authenticated;
grant execute on function public.poi_increment(text, date) to anon, authenticated;
grant execute on function public.poi_decrement(text, date) to anon, authenticated;
grant execute on function public.poi_summary(date) to anon, authenticated;
grant execute on function public.poi_distribution(date) to anon, authenticated;
