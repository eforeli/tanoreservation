-- Weekly multi-period opening hours, preserving existing schedules and reservations.
alter table public.weekly_business_hours add column if not exists periods jsonb;
update public.weekly_business_hours
set periods = case
  when is_closed or opens_at is null or closes_at is null then '[]'::jsonb
  else jsonb_build_array(jsonb_build_object('start',to_char(opens_at,'HH24:MI'),'end',to_char(closes_at,'HH24:MI')))
end where periods is null;

create or replace function public.booking_valid_slot(p_date date,p_clock time,p_party int)
returns boolean language plpgsql stable set search_path=public as $$
declare s public.booking_settings%rowtype; sp public.special_business_hours%rowtype;
        wh public.weekly_business_hours%rowtype; segments jsonb; seg jsonb;
        o time; c time; ts timestamptz;
begin
 select * into s from public.booking_settings where id=1;
 if s.id is null or p_party<1 or p_party>s.max_online_party_size then return false;end if;
 if p_date<(now() at time zone 'Asia/Taipei')::date
    or p_date>(now() at time zone 'Asia/Taipei')::date+s.booking_window_days then return false;end if;
 ts:=(p_date::text||' '||p_clock::text)::timestamp at time zone 'Asia/Taipei';
 if ts<now()+make_interval(mins=>s.min_advance_minutes) then return false;end if;
 select * into sp from public.special_business_hours where business_date=p_date;
 if found then
  if sp.is_closed then return false;end if;
  segments:=sp.periods;
  if segments is null or jsonb_array_length(segments)=0 then
   if sp.opens_at is null or sp.closes_at is null then return false;end if;
   segments:=jsonb_build_array(jsonb_build_object('start',to_char(sp.opens_at,'HH24:MI'),'end',to_char(sp.closes_at,'HH24:MI')));
  end if;
 else
  select * into wh from public.weekly_business_hours where weekday=extract(dow from p_date)::int;
  if not found or wh.is_closed then return false;end if;
  segments:=wh.periods;
  if segments is null or jsonb_array_length(segments)=0 then
   if wh.opens_at is null or wh.closes_at is null then return false;end if;
   segments:=jsonb_build_array(jsonb_build_object('start',to_char(wh.opens_at,'HH24:MI'),'end',to_char(wh.closes_at,'HH24:MI')));
  end if;
 end if;
 for seg in select value from jsonb_array_elements(segments) loop
  o:=(seg->>'start')::time;c:=(seg->>'end')::time;
  if p_clock>=o and p_clock<=c-make_interval(mins=>s.last_seating_offset_minutes)
     and mod((extract(epoch from (p_clock-o))/60)::int,s.slot_interval_minutes)=0 then return true;end if;
 end loop;
 return false;
end $$;

create or replace function public.get_available_slots(p_date date,p_party_size integer)
returns text[] language plpgsql security definer set search_path=public as $$
declare s public.booking_settings%rowtype; sp public.special_business_hours%rowtype;
        wh public.weekly_business_hours%rowtype;segments jsonb;seg jsonb;
        o time;c time;cur time;list text[]:='{}';
begin
 select * into s from public.booking_settings where id=1;
 if s.id is null or p_party_size<1 or p_party_size>s.max_online_party_size then return list;end if;
 select * into sp from public.special_business_hours where business_date=p_date;
 if found then
  if sp.is_closed then return list;end if;
  segments:=sp.periods;
  if segments is null or jsonb_array_length(segments)=0 then
   if sp.opens_at is null or sp.closes_at is null then return list;end if;
   segments:=jsonb_build_array(jsonb_build_object('start',to_char(sp.opens_at,'HH24:MI'),'end',to_char(sp.closes_at,'HH24:MI')));
  end if;
 else
  select * into wh from public.weekly_business_hours where weekday=extract(dow from p_date)::int;
  if not found or wh.is_closed then return list;end if;
  segments:=wh.periods;
  if segments is null or jsonb_array_length(segments)=0 then
   if wh.opens_at is null or wh.closes_at is null then return list;end if;
   segments:=jsonb_build_array(jsonb_build_object('start',to_char(wh.opens_at,'HH24:MI'),'end',to_char(wh.closes_at,'HH24:MI')));
  end if;
 end if;
 for seg in select value from jsonb_array_elements(segments) loop
  o:=(seg->>'start')::time;c:=(seg->>'end')::time;cur:=o;
  while cur<=c loop
   if public.booking_valid_slot(p_date,cur,p_party_size)
      and public.find_table_for_booking((p_date::text||' '||cur::text)::timestamp at time zone 'Asia/Taipei',p_party_size) is not null
    then list:=array_append(list,to_char(cur,'HH24:MI'));end if;
   cur:=cur+make_interval(mins=>s.slot_interval_minutes);
  end loop;
 end loop;
 return array(select distinct x from unnest(list) x order by x);
end $$;
revoke execute on function public.booking_valid_slot(date,time,int) from public,anon,authenticated;
grant execute on function public.booking_valid_slot(date,time,int) to service_role;
revoke execute on function public.get_available_slots(date,int) from public,anon,authenticated;
grant execute on function public.get_available_slots(date,int) to service_role;