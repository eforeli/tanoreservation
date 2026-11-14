-- Applied to live Supabase as TANO V1.6 partial closures / availability states.
alter table public.special_business_hours add column if not exists closure_periods jsonb not null default '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.booking_day_periods(p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare sp public.special_business_hours%rowtype;
        wh public.weekly_business_hours%rowtype;
        periods jsonb:='[]'::jsonb; next_periods jsonb;
        seg jsonb; closure jsonb;
        lo time;hi time;cs time;ce time;
begin
 select * into sp from public.special_business_hours where business_date=p_date;
 if found and sp.is_closed then return '[]'::jsonb;end if;
 if found and coalesce(jsonb_array_length(sp.closure_periods),0)=0 then
  if coalesce(jsonb_array_length(sp.periods),0)>0 then return sp.periods;end if;
  if sp.opens_at is not null and sp.closes_at is not null then
   return jsonb_build_array(jsonb_build_object('start',to_char(sp.opens_at,'HH24:MI'),'end',to_char(sp.closes_at,'HH24:MI')));
  end if;
  return '[]'::jsonb;
 end if;
 select * into wh from public.weekly_business_hours where weekday=extract(dow from p_date)::int;
 if not found or wh.is_closed then return '[]'::jsonb;end if;
 if coalesce(jsonb_array_length(wh.periods),0)>0 then periods:=wh.periods;
 elsif wh.opens_at is not null and wh.closes_at is not null then
  periods:=jsonb_build_array(jsonb_build_object('start',to_char(wh.opens_at,'HH24:MI'),'end',to_char(wh.closes_at,'HH24:MI')));
 end if;
 if not found then return periods;end if;
 for closure in select value from jsonb_array_elements(coalesce(sp.closure_periods,'[]'::jsonb)) loop
  cs:=(closure->>'start')::time;ce:=(closure->>'end')::time;
  next_periods:='[]'::jsonb;
  for seg in select value from jsonb_array_elements(periods) loop
   lo:=(seg->>'start')::time;hi:=(seg->>'end')::time;
   if ce<=lo or cs>=hi then next_periods:=next_periods||jsonb_build_array(seg);
   else
    if lo<cs then next_periods:=next_periods||jsonb_build_array(jsonb_build_object('start',to_char(lo,'HH24:MI'),'end',to_char(cs,'HH24:MI')));end if;
    if ce<hi then next_periods:=next_periods||jsonb_build_array(jsonb_build_object('start',to_char(ce,'HH24:MI'),'end',to_char(hi,'HH24:MI')));end if;
   end if;
  end loop;
  periods:=next_periods;
 end loop;
 return periods;
end $function$;

CREATE OR REPLACE FUNCTION public.booking_day_state(p_date date, p_party_size integer)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.booking_settings%rowtype;segments jsonb;seg jsonb;
        o time;c time;cur time;had_eligible boolean:=false;
begin
 select * into s from public.booking_settings where id=1;
 segments:=public.booking_day_periods(p_date);
 if jsonb_array_length(segments)=0 then return 'closed';end if;
 if s.id is null or p_party_size<1 or p_party_size>s.max_online_party_size then return 'unavailable';end if;
 for seg in select value from jsonb_array_elements(segments) loop
  o:=(seg->>'start')::time;c:=(seg->>'end')::time;cur:=o;
  while cur<=c loop
   if public.booking_valid_slot(p_date,cur,p_party_size) then
    had_eligible:=true;
    if public.find_table_for_booking((p_date::text||' '||cur::text)::timestamp at time zone 'Asia/Taipei',p_party_size) is not null then return 'available';end if;
   end if;
   cur:=cur+make_interval(mins=>s.slot_interval_minutes);
  end loop;
 end loop;
 if had_eligible then return 'full';end if;
 return 'unavailable';
end $function$;

CREATE OR REPLACE FUNCTION public.booking_valid_slot(p_date date, p_clock time without time zone, p_party integer)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare s public.booking_settings%rowtype; segments jsonb;seg jsonb;
        sp public.special_business_hours%rowtype;
        o time;c time;ts timestamptz;cl jsonb;
begin
 select * into s from public.booking_settings where id=1;
 if s.id is null or p_party<1 or p_party>s.max_online_party_size then return false;end if;
 if p_date<(now() at time zone 'Asia/Taipei')::date or p_date>(now() at time zone 'Asia/Taipei')::date+s.booking_window_days then return false;end if;
 ts:=(p_date::text||' '||p_clock::text)::timestamp at time zone 'Asia/Taipei';
 if ts<now()+make_interval(mins=>s.min_advance_minutes) then return false;end if;
 segments:=public.booking_day_periods(p_date);
 select * into sp from public.special_business_hours where business_date=p_date;
 if found and coalesce(jsonb_array_length(sp.closure_periods),0)>0 then
  for cl in select value from jsonb_array_elements(sp.closure_periods) loop
   -- Never let a new dining window cross the partial-closure boundary.
   if p_clock < (cl->>'end')::time and
      p_clock+make_interval(mins=>s.dining_minutes) > (cl->>'start')::time then return false;end if;
  end loop;
 end if;
 for seg in select value from jsonb_array_elements(segments) loop
  o:=(seg->>'start')::time;c:=(seg->>'end')::time;
  if p_clock>=o and p_clock<=c-make_interval(mins=>s.last_seating_offset_minutes)
   and mod((extract(epoch from (p_clock-o))/60)::int,s.slot_interval_minutes)=0 then return true;end if;
 end loop;
 return false;
end $function$;

CREATE OR REPLACE FUNCTION public.get_available_slots(p_date date, p_party_size integer)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.booking_settings%rowtype;
        seg jsonb; segments jsonb;
        o time;c time;cur time;list text[]:='{}';
begin
 select * into s from public.booking_settings where id=1;
 if s.id is null or p_party_size<1 or p_party_size>s.max_online_party_size then return list;end if;
 segments:=public.booking_day_periods(p_date);
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
end $function$;

revoke execute on function public.booking_day_periods(date) from public,anon,authenticated;
grant execute on function public.booking_day_periods(date) to service_role;
revoke execute on function public.booking_day_state(date,int) from public,anon,authenticated;
grant execute on function public.booking_day_state(date,int) to service_role;
revoke execute on function public.booking_valid_slot(date,time,int) from public,anon,authenticated;
grant execute on function public.booking_valid_slot(date,time,int) to service_role;
revoke execute on function public.get_available_slots(date,int) from public,anon,authenticated;
grant execute on function public.get_available_slots(date,int) to service_role;
