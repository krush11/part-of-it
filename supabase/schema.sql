-- Part of It Counter: run this once in Supabase → SQL Editor → New query.
-- Safe to re-run.
--
-- The app talks to Supabase with the public (publishable) key, so the table
-- itself is locked away from that key. Students can only go through the
-- functions below, which can add or remove one tap for an email and read the
-- class totals and today's distribution (which lists who has which count).
-- They can't set arbitrary counts or read past days' emails.

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

create or replace function public.poi_join(p_email text, p_day date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  result integer;
begin
  perform public.poi_assert_today(p_day);
  insert into public.part_of_it_counts (email, day)
  values (lower(trim(p_email)), p_day)
  on conflict (email, day) do nothing;
  select c.count into result from public.part_of_it_counts c
   where c.email = lower(trim(p_email)) and c.day = p_day;
  return result;
end;
$$;

create or replace function public.poi_increment(p_email text, p_day date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  result integer;
begin
  perform public.poi_assert_today(p_day);
  insert into public.part_of_it_counts as c (email, day, count)
  values (lower(trim(p_email)), p_day, 1)
  on conflict (email, day)
  do update set count = c.count + 1, updated_at = now()
  returning c.count into result;
  return result;
end;
$$;

create or replace function public.poi_decrement(p_email text, p_day date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  result integer;
begin
  perform public.poi_assert_today(p_day);
  update public.part_of_it_counts c
     set count = greatest(c.count - 1, 0), updated_at = now()
   where c.email = lower(trim(p_email)) and c.day = p_day
  returning c.count into result;
  return coalesce(result, 0);
end;
$$;

-- Class total per day = the mode of everyone's counts. Ordering by count desc
-- makes mode() pick the highest value on a tie (late joiners count lower).
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

-- Today's distribution: each count, how many students have it, and their emails.
create or replace function public.poi_distribution(p_day date)
returns table (count integer, students integer, emails text[])
language sql
stable
security definer
set search_path = ''
as $$
  select c.count,
         count(*)::integer,
         array_agg(c.email order by c.email)
    from public.part_of_it_counts c
   where c.day = p_day
   group by c.count
   order by c.count desc;
$$;

revoke execute on function public.poi_assert_today(date) from public, anon, authenticated;
revoke execute on function public.poi_join(text, date) from public;
revoke execute on function public.poi_increment(text, date) from public;
revoke execute on function public.poi_decrement(text, date) from public;
revoke execute on function public.poi_daily_modes(date, integer) from public;
grant execute on function public.poi_join(text, date) to anon, authenticated;
grant execute on function public.poi_increment(text, date) to anon, authenticated;
grant execute on function public.poi_decrement(text, date) to anon, authenticated;
grant execute on function public.poi_daily_modes(date, integer) to anon, authenticated;
revoke execute on function public.poi_distribution(date) from public;
grant execute on function public.poi_distribution(date) to anon, authenticated;
