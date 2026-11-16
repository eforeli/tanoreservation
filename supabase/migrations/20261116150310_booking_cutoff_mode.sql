set local lock_timeout = '3s';
-- Existing settings and booking rows retain their prior behaviour by default.
alter table public.booking_settings
 add column booking_cutoff_mode text not null default 'minutes'
 check (booking_cutoff_mode in ('minutes','opening'));

create function public.booking_day_cutoff_reached(p_date date,p_now timestamptz)
returns boolean language sql stable set search_path='' as $$
 select case
  when p_date is distinct from (p_now at time zone 'Asia/Taipei')::date then false
  when not exists (
   select 1 from public.booking_settings where id=1 and booking_cutoff_mode='opening'
  ) then false
  else coalesce((
   select (p_now at time zone 'Asia/Taipei')::time >= min((period->>'start')::time)
   from jsonb_array_elements(public.booking_day_periods(p_date)) as periods(period)
  ),false)
 end;
$$;
revoke all on function public.booking_day_cutoff_reached(date,timestamptz) from public,anon,authenticated;

-- Format the same effective hours for availability and late submissions.
create function public.booking_walk_in_notice(p_date date)
returns text language sql stable set search_path='' as $$
 select '今日營業時間 ' || string_agg(
  to_char(p_date+(period->>'start')::time,'HH24:MI') || '–' ||
  to_char(p_date+(period->>'end')::time,'HH24:MI'),
  '、' order by (period->>'start')::time
 ) || '，可至現場候位。'
 from jsonb_array_elements(public.booking_day_periods(p_date)) as periods(period);
$$;
revoke all on function public.booking_walk_in_notice(date) from public,anon,authenticated;

CREATE FUNCTION public.booking_valid_slot_for_channel(p_date date, p_clock time without time zone, p_party integer, p_online boolean)
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
 if s.booking_cutoff_mode='opening' then
  if ts<clock_timestamp() then return false;end if;
  if p_online and public.booking_day_cutoff_reached(p_date,clock_timestamp()) then return false;end if;
 elsif ts<clock_timestamp()+make_interval(mins=>s.min_advance_minutes) then
  return false;
 end if;
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

revoke all on function public.booking_valid_slot_for_channel(date,time,int,boolean) from public,anon,authenticated;

-- Staff bypass the opening cutoff while retaining ordinary slot validation.
create or replace function public.booking_valid_slot(p_date date,p_clock time,p_party int)
returns boolean language sql volatile set search_path='' as $$
 select public.booking_valid_slot_for_channel(p_date,p_clock,p_party,false);
$$;

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
 if public.booking_day_cutoff_reached(p_date,clock_timestamp()) then return false;end if;
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

create or replace function public.booking_day_state(p_date date,p_party_size int)
returns text language plpgsql security definer set search_path='' as $$
declare slot timestamp; had_eligible boolean:=false; step int;
begin
 if jsonb_array_length(public.booking_day_periods(p_date))=0 then return 'closed';end if;
 if public.booking_day_cutoff_reached(p_date,clock_timestamp()) then return 'walk_in';end if;
 select slot_interval_minutes into step from public.booking_settings where id=1;
 for slot in select candidate from public.booking_slot_candidates(p_date,step) loop
  if public.booking_valid_slot_for_channel(p_date,slot::time,p_party_size,true) then
   had_eligible:=true;
   if public.find_table_for_booking(slot at time zone 'Asia/Taipei',p_party_size) is not null then
    if public.booking_day_cutoff_reached(p_date,clock_timestamp()) then return 'walk_in';end if;
    return 'available';
   end if;
  end if;
 end loop;
 if public.booking_day_cutoff_reached(p_date,clock_timestamp()) then return 'walk_in';end if;
 if had_eligible then return 'full';end if;
 return 'unavailable';
end $$;

create function public.booking_day_status(p_date date,p_party_size int)
returns jsonb language plpgsql security definer set search_path='' as $$
declare day_state text;
begin
 day_state:=public.booking_day_state(p_date,p_party_size);
 if day_state='walk_in' then
  return jsonb_build_object('state',day_state,'notice',public.booking_walk_in_notice(p_date));
 end if;
 return jsonb_build_object('state',day_state);
end $$;
revoke all on function public.booking_day_status(date,int) from public,anon,authenticated;
grant execute on function public.booking_day_status(date,int) to service_role;

create or replace function public.get_available_slots(p_date date,p_party_size int)
returns text[] language sql security definer set search_path='' as $$
 select coalesce(array_agg(to_char(candidate,'HH24:MI') order by candidate),'{}')
 from public.booking_settings s
 cross join lateral public.booking_slot_candidates(p_date,s.slot_interval_minutes)
 where s.id=1 and public.booking_valid_slot_for_channel(p_date,candidate::time,p_party_size,true)
   and public.find_table_for_booking(candidate at time zone 'Asia/Taipei',p_party_size) is not null;
$$;

create or replace function public.create_booking(p_date date,p_time text,p_party_size int,p_name text,p_phone text,p_notes text,p_source text,p_key uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare fixed_end timestamptz; start_ts timestamptz; t_id uuid; s public.booking_settings%rowtype; r public.reservations%rowtype;old public.reservations%rowtype;
begin
 perform public.lock_reservation_inventory();
 if p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'not eligible';end if;
 if length(trim(p_name))<1 or length(p_name)>80 or length(p_phone)>20 or length(p_phone)<8 or length(coalesce(p_notes,''))>500 then raise exception 'not eligible';end if;
 if p_source not in ('web','phone','line_message','walk_in','admin') then raise exception 'not eligible';end if;
 if p_source<>'web' and p_actor is null then raise exception 'not eligible';end if;
 select * into old from public.reservations where idempotency_key=p_key;
 if found then
  if old.guest_phone<>p_phone or old.party_size<>p_party_size or old.starts_at<>((p_date::text||' '||p_time)::timestamp at time zone 'Asia/Taipei') then raise exception 'idempotency conflict';end if;
  return jsonb_build_object('confirmation_code',old.confirmation_code,'starts_at',old.starts_at,'party_size',old.party_size,'guest_name',old.guest_name);
 end if;
 if p_source='web' and public.booking_day_cutoff_reached(p_date,clock_timestamp()) then raise exception 'booking day cutoff' using detail=coalesce(public.booking_walk_in_notice(p_date),'');end if;
 -- Guard only online creations; manual admin entry remains available for exceptional cases.
 -- Existing confirmed/seated reservations from any source count against this check.
 if p_source='web' and public.has_active_phone_booking(p_date,p_phone,null) then
  raise exception 'duplicate phone booking day' using errcode='P0001';
 end if;
 if not public.booking_valid_slot_for_channel(p_date,p_time::time,p_party_size,p_source='web') then
  if p_source='web' and public.booking_day_cutoff_reached(p_date,clock_timestamp()) then raise exception 'booking day cutoff' using detail=coalesce(public.booking_walk_in_notice(p_date),'');end if;
  raise exception 'not eligible';
 end if;
 start_ts := (p_date::text||' '||p_time)::timestamp at time zone 'Asia/Taipei';
 t_id:=public.find_table_for_booking(start_ts,p_party_size);
 if t_id is null then raise exception 'unavailable';end if;
 if p_source='web' and public.booking_day_cutoff_reached(p_date,clock_timestamp()) then raise exception 'booking day cutoff' using detail=coalesce(public.booking_walk_in_notice(p_date),'');end if;
 select * into s from public.booking_settings where id=1;
 fixed_end:=public.fixed_booking_end(p_date,p_time::time);
 insert into public.reservations(guest_name,guest_phone,party_size,starts_at,dining_ends_at,table_released_at,notes,source,idempotency_key) values(trim(p_name),trim(p_phone),p_party_size,start_ts,coalesce(fixed_end,start_ts+make_interval(mins=>s.dining_minutes)),coalesce(fixed_end,start_ts+make_interval(mins=>s.dining_minutes+s.buffer_minutes)),coalesce(p_notes,''),p_source,p_key) returning * into r;
 insert into public.reservation_tables(reservation_id,table_id) values(r.id,t_id);
 if p_actor is not null then insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,new_value) values(p_actor,'create','reservation',r.id,to_jsonb(r));end if;
 return jsonb_build_object('confirmation_code',r.confirmation_code,'starts_at',r.starts_at,'party_size',r.party_size,'guest_name',r.guest_name);
end $$;

create or replace function public.customer_update_booking(
 p_token_hash text,p_date date,p_time text,p_party int,
 p_name text,p_phone text,p_notes text,p_expected_updated_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public as $$
declare fixed_end timestamptz; old public.reservations%rowtype; r public.reservations%rowtype;
 target uuid; s public.booking_settings%rowtype;
 new_start timestamptz;session_res uuid; changed_slot boolean;
begin
 perform public.lock_reservation_inventory();
 select a.reservation_id into session_res from public.customer_booking_sessions a
 where a.token_hash=p_token_hash and a.expires_at>now();
 if session_res is null then raise exception 'session expired';end if;
 select * into old from public.reservations where id=session_res for update;
 if not found then raise exception 'session expired';end if;
 if old.updated_at is distinct from p_expected_updated_at then raise exception 'reservation changed';end if;
 if p_name is distinct from old.guest_name or p_phone is distinct from old.guest_phone then raise exception 'identity immutable';end if;
 if old.status<>'confirmed' or old.starts_at<=clock_timestamp() then raise exception 'not eligible';end if;
 if p_date is null or p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or p_party<1 or p_party>5 or length(trim(p_name))<1 or length(p_name)>80
  or p_phone !~ '^09[0-9]{8}$' or length(coalesce(p_notes,''))>500
  then raise exception 'not eligible';end if;
 new_start:=(p_date::text||' '||p_time)::timestamp at time zone 'Asia/Taipei';
 if new_start<=clock_timestamp() then raise exception 'not eligible';end if;
 if p_date<>(old.starts_at at time zone 'Asia/Taipei')::date
    and public.has_active_phone_booking(p_date,p_phone,old.id) then
  raise exception 'duplicate phone booking day';
 end if;
 changed_slot := new_start<>old.starts_at or p_party<>old.party_size;
 if changed_slot then
  if not public.customer_valid_edit_slot(p_date,p_time::time,p_party) then
   if public.booking_day_cutoff_reached(p_date,clock_timestamp()) then raise exception 'booking day cutoff' using detail=coalesce(public.booking_walk_in_notice(p_date),'');end if;
   raise exception 'not eligible';
  end if;
  target:=public.find_table_for_booking(new_start,p_party,old.id);
  if public.booking_day_cutoff_reached(p_date,clock_timestamp()) then raise exception 'booking day cutoff' using detail=coalesce(public.booking_walk_in_notice(p_date),'');end if;
  if target is null then raise exception 'unavailable';end if;
 end if;
 select * into s from public.booking_settings where id=1;
 fixed_end:=public.fixed_booking_end(p_date,p_time::time);
 update public.reservations set
  notes=coalesce(p_notes,''),
  party_size=p_party,starts_at=new_start,
  dining_ends_at=case when changed_slot then coalesce(fixed_end,new_start+make_interval(mins=>s.dining_minutes)) else old.dining_ends_at end,
  table_released_at=case when changed_slot then coalesce(fixed_end,new_start+make_interval(mins=>s.dining_minutes+s.buffer_minutes)) else old.table_released_at end,
  updated_at=clock_timestamp()
 where id=old.id returning * into r;
 if changed_slot then update public.reservation_tables set table_id=target where reservation_id=old.id;end if;
 insert into public.customer_booking_audit_logs(reservation_id,action,old_value,new_value)
 values(old.id,'update',public.customer_booking_json(old),public.customer_booking_json(r));
 -- Invalidate token on success: old phone must not retain access.
 delete from public.customer_booking_sessions where reservation_id=old.id;
 return public.customer_booking_json(r);
end $$;
