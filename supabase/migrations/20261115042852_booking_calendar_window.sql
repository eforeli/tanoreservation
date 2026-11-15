-- Calendar dates are inclusive: with a 30-day window, today plus 29 is the last day.
create function public.booking_calendar()
returns jsonb language sql stable security definer set search_path='' as $$
 with calendar as (
  select (statement_timestamp() at time zone 'Asia/Taipei')::date as today,
         booking_window_days as days
  from public.booking_settings
  where id=1
 )
 select jsonb_build_object(
  'today',today,
  'lastDate',today+(days-1),
  'windowDays',days,
  'closedDates',coalesce((
   select jsonb_agg(today+offset_day order by offset_day)
   from generate_series(0,days-1) as offsets(offset_day)
   where jsonb_array_length(public.booking_day_periods(today+offset_day))=0
  ),'[]'::jsonb)
 )
 from calendar;
$$;
revoke all on function public.booking_calendar() from public,anon,authenticated;
grant execute on function public.booking_calendar() to service_role;


CREATE OR REPLACE FUNCTION public.booking_valid_slot(p_date date, p_clock time without time zone, p_party integer)
 RETURNS boolean
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $function$
declare s public.booking_settings%rowtype; segments jsonb;seg jsonb;
        sp public.special_business_hours%rowtype;
        o time;c time;ts timestamptz;cl jsonb;
begin
 select * into s from public.booking_settings where id=1;
 if s.id is null or p_party<1 or p_party>s.max_online_party_size then return false;end if;
 if p_date<(clock_timestamp() at time zone 'Asia/Taipei')::date or p_date>(clock_timestamp() at time zone 'Asia/Taipei')::date+(s.booking_window_days-1) then return false;end if;
 ts:=(p_date::text||' '||p_clock::text)::timestamp at time zone 'Asia/Taipei';
 if ts<clock_timestamp()+make_interval(mins=>s.min_advance_minutes) then return false;end if;
 if cardinality(public.fixed_booking_times(p_date))>0 then
  return public.fixed_booking_end(p_date,p_clock) is not null;
 end if;
 segments:=public.booking_day_periods(p_date);
 select * into sp from public.special_business_hours where business_date=p_date;
 if found and coalesce(jsonb_array_length(sp.closure_periods),0)>0 then
  for cl in select value from jsonb_array_elements(sp.closure_periods) loop
   -- Never let a new dining window cross the partial-closure boundary.
   if p_clock < (cl->>'end')::time and
      p_date+p_clock+make_interval(mins=>s.dining_minutes) > p_date+(cl->>'start')::time then return false;end if;
  end loop;
 end if;
 for seg in select value from jsonb_array_elements(segments) loop
  o:=(seg->>'start')::time;c:=(seg->>'end')::time;
  if p_clock>=o and p_date+p_clock<=p_date+c-make_interval(mins=>s.last_seating_offset_minutes)
   and mod((extract(epoch from (p_clock-o))/60)::int,s.slot_interval_minutes)=0 then return true;end if;
 end loop;
 return false;
end $function$;

create or replace function public.customer_valid_edit_slot(p_date date,p_clock time,p_party int)
returns boolean language plpgsql volatile set search_path=public as $$
declare s public.booking_settings%rowtype;segments jsonb;seg jsonb;sp public.special_business_hours%rowtype;
 o time;c time;ts timestamptz;cl jsonb;
begin
 select * into s from public.booking_settings where id=1;
 if s.id is null or p_party<1 or p_party>s.max_online_party_size then return false;end if;
 if p_date<(clock_timestamp() at time zone 'Asia/Taipei')::date or p_date>(clock_timestamp() at time zone 'Asia/Taipei')::date+(s.booking_window_days-1) then return false;end if;
 ts:=(p_date::text||' '||p_clock::text)::timestamp at time zone 'Asia/Taipei';
 if ts<=clock_timestamp() then return false;end if;
 if cardinality(public.fixed_booking_times(p_date))>0 then
  return public.fixed_booking_end(p_date,p_clock) is not null;
 end if;
 segments:=public.booking_day_periods(p_date);
 select * into sp from public.special_business_hours where business_date=p_date;
 if found and coalesce(jsonb_array_length(sp.closure_periods),0)>0 then
  for cl in select value from jsonb_array_elements(sp.closure_periods) loop
   if p_clock<(cl->>'end')::time and p_date+p_clock+make_interval(mins=>s.dining_minutes)>p_date+(cl->>'start')::time then return false;end if;
  end loop;
 end if;
 for seg in select value from jsonb_array_elements(segments) loop
  o:=(seg->>'start')::time;c:=(seg->>'end')::time;
  if p_clock>=o and p_date+p_clock<=p_date+c-make_interval(mins=>s.last_seating_offset_minutes)
   and mod((extract(epoch from (p_clock-o))/60)::int,s.slot_interval_minutes)=0 then return true;end if;
 end loop;
 return false;
end $$;
