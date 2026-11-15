alter table public.weekly_business_hours
 add column fixed_seating_times time[] not null default '{}';
alter table public.special_business_hours
 add column fixed_seating_times time[] not null default '{}';

-- A special opening replaces the weekly schedule. A partial closure only cuts its windows.
create function public.fixed_booking_times(p_date date)
returns time[] language sql stable set search_path='' as $$
 select case
   when special.is_closed then '{}'::time[]
   when special.business_date is not null and jsonb_array_length(special.closure_periods)=0
     then special.fixed_seating_times
   else coalesce(weekly.fixed_seating_times,'{}'::time[])
 end
 from (select p_date as business_date) as day
 left join public.special_business_hours special using (business_date)
 left join public.weekly_business_hours weekly on weekly.weekday=extract(dow from day.business_date);
$$;
revoke all on function public.fixed_booking_times(date) from public,anon,authenticated;

-- The slot owns the table until the next seating in the same open window, or closing.
create function public.fixed_booking_end(p_date date,p_clock time)
returns timestamptz language sql stable set search_path='' as $$
 select (p_date+least((period->>'end')::time,
   (select min(seating) from unnest(times) as seat(seating) where seating>p_clock)
 )) at time zone 'Asia/Taipei'
 from public.fixed_booking_times(p_date) as t(times)
 cross join lateral jsonb_array_elements(public.booking_day_periods(p_date)) as segment(period)
 where p_clock=any(times) and p_clock >= (period->>'start')::time and p_clock < (period->>'end')::time;
$$;
revoke all on function public.fixed_booking_end(date,time) from public,anon,authenticated;


create or replace function public.booking_slot_candidates(p_date date,p_interval int)
returns table (candidate timestamp) language sql stable set search_path='' as $$
 select slot
 from jsonb_array_elements(public.booking_day_periods(p_date)) as period
 cross join lateral generate_series(
  p_date+(period->>'start')::time,
  p_date+(period->>'end')::time,
  make_interval(mins=>nullif(greatest(p_interval,0),0))
 ) as slots(slot)
 where slot < p_date+interval '1 day' and cardinality(public.fixed_booking_times(p_date))=0
 union
 select p_date+seating
 from unnest(public.fixed_booking_times(p_date)) as seat(seating)
 where public.fixed_booking_end(p_date,seating) is not null
 order by 1;
$$;

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
 if p_date<(clock_timestamp() at time zone 'Asia/Taipei')::date or p_date>(clock_timestamp() at time zone 'Asia/Taipei')::date+s.booking_window_days then return false;end if;
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
 if p_date<(clock_timestamp() at time zone 'Asia/Taipei')::date or p_date>(clock_timestamp() at time zone 'Asia/Taipei')::date+s.booking_window_days then return false;end if;
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

create or replace function public.find_table_for_booking(p_start timestamptz,p_party int,p_exclude uuid default null)
returns uuid language plpgsql stable set search_path=public as $$
declare s public.booking_settings%rowtype;t public.restaurant_tables%rowtype;finish timestamptz;chair_finish timestamptz;fixed_end timestamptz;needed int;begin
 select * into s from public.booking_settings where id=1;
 fixed_end:=public.fixed_booking_end((p_start at time zone 'Asia/Taipei')::date,(p_start at time zone 'Asia/Taipei')::time);
 finish:=coalesce(fixed_end,p_start+make_interval(mins=>s.dining_minutes+s.buffer_minutes));
 chair_finish:=coalesce(fixed_end,p_start+make_interval(mins=>s.dining_minutes));
 if (select count(*) from public.reservations r where r.status in ('confirmed','seated') and r.id is distinct from p_exclude and r.starts_at=p_start)>=s.max_arrivals_per_slot then return null;end if;
 for t in select * from public.restaurant_tables where is_active and max_capacity>=p_party order by case when p_party<=2 then case code when 'A2' then 0 when 'A1' then 1 when 'A3' then 2 when 'A4' then 3 else 4 end when p_party=3 then case code when 'A4' then 0 when 'A5' then 1 when 'A1' then 2 when 'A3' then 3 else 4 end else case code when 'A4' then 0 else 1 end end,sort_order loop
  if exists(select 1 from public.reservations r join public.reservation_tables rt on rt.reservation_id=r.id where rt.table_id=t.id and r.status in ('confirmed','seated') and r.id is distinct from p_exclude and r.starts_at<finish and r.table_released_at>p_start) then continue;end if;
  if exists(select 1 from public.table_blocks b where b.table_id=t.id and b.released_at is null and b.start_at<finish and coalesce(b.end_at,'infinity'::timestamptz)>p_start) then continue;end if;
  needed:=greatest(0,p_party-t.base_capacity); if needed>s.extra_chairs_total then continue;end if;
  -- Either small table may use a chair, but their dining windows cannot overlap.
  if needed>0 and t.code in ('A1','A3') and exists (
   select 1
   from public.reservations r
   join public.reservation_tables rt on rt.reservation_id=r.id
   join public.restaurant_tables small on small.id=rt.table_id
   where small.code in ('A1','A3') and small.id<>t.id
     and r.status in ('confirmed','seated') and r.id is distinct from p_exclude
     and r.party_size>small.base_capacity
     and r.starts_at<chair_finish and r.dining_ends_at>p_start
  ) then continue;end if;
  -- Sweep all endpoints of overlapping extra chair intervals; evaluate usage at each boundary.
  if needed>0 then
   if exists(
    with active as (select r.starts_at as a,r.dining_ends_at as b,greatest(0,r.party_size-z.base_capacity) as n from public.reservations r join public.reservation_tables rt on rt.reservation_id=r.id join public.restaurant_tables z on z.id=rt.table_id where r.status in ('confirmed','seated') and r.id is distinct from p_exclude and r.starts_at<chair_finish and r.dining_ends_at>p_start),
    points as (select p_start as x union select a from active where a>=p_start and a<chair_finish union select b from active where b>=p_start and b<chair_finish)
    select 1 from points where needed+(select coalesce(sum(n),0) from active where a<=points.x and b>points.x)>s.extra_chairs_total
   ) then continue;end if;
  end if;
  return t.id;
 end loop;
 return null;
end $$;

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
 -- Guard only online creations; manual admin entry remains available for exceptional cases.
 -- Existing confirmed/seated reservations from any source count against this check.
 if p_source='web' and public.has_active_phone_booking(p_date,p_phone,null) then
  raise exception 'duplicate phone booking day' using errcode='P0001';
 end if;
 if not public.booking_valid_slot(p_date,p_time::time,p_party_size) then raise exception 'not eligible';end if;
 start_ts := (p_date::text||' '||p_time)::timestamp at time zone 'Asia/Taipei';
 t_id:=public.find_table_for_booking(start_ts,p_party_size);
 if t_id is null then raise exception 'unavailable';end if;
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
  if not public.customer_valid_edit_slot(p_date,p_time::time,p_party) then raise exception 'not eligible';end if;
  target:=public.find_table_for_booking(new_start,p_party,old.id);
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

create or replace function public.admin_update_booking_versioned(p_id uuid,p_date date,p_time text,p_party int,p_name text,p_phone text,p_notes text,p_status text,p_actor uuid,p_expected_updated_at timestamptz)
returns void language plpgsql security definer set search_path=public as $$
declare fixed_end timestamptz; old public.reservations%rowtype; new_start timestamptz;target uuid;s public.booking_settings%rowtype;changed_slot boolean;
begin
 perform public.lock_reservation_inventory();
 select * into old from public.reservations where id=p_id for update;if not found then raise exception 'not found';end if;
 if p_expected_updated_at is not null and old.updated_at is distinct from p_expected_updated_at then
  raise exception 'reservation changed';
 end if;
 if old.status='cancelled' or p_status not in ('confirmed','seated','completed','no_show') then raise exception 'invalid transition';end if;
 if length(trim(p_name))=0 or length(p_name)>80 or length(p_phone)<8 or length(p_phone)>20 or length(coalesce(p_notes,''))>500 then raise exception 'not eligible';end if;
 if p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'not eligible';end if;
 new_start:=(p_date::text||' '||p_time)::timestamp at time zone 'Asia/Taipei';
 changed_slot:=new_start is distinct from old.starts_at or p_party is distinct from old.party_size
    or (p_status in ('confirmed','seated') and old.status not in ('confirmed','seated'));
 if changed_slot then
  if not public.booking_valid_slot(p_date,p_time::time,p_party) then raise exception 'not eligible';end if;
  target:=public.find_table_for_booking(new_start,p_party,p_id);
  if target is null then raise exception 'unavailable';end if;
 end if;
 select * into s from public.booking_settings where id=1;
 fixed_end:=public.fixed_booking_end(p_date,p_time::time);
 update public.reservations set
  guest_name=trim(p_name),guest_phone=trim(p_phone),notes=coalesce(p_notes,''),party_size=p_party,
  starts_at=new_start,status=p_status,updated_at=clock_timestamp(),
  dining_ends_at=case when changed_slot then coalesce(fixed_end,new_start+make_interval(mins=>s.dining_minutes)) else old.dining_ends_at end,
  table_released_at=case when changed_slot then coalesce(fixed_end,new_start+make_interval(mins=>s.dining_minutes+s.buffer_minutes)) else old.table_released_at end
 where id=p_id;
 if changed_slot then update public.reservation_tables set table_id=target where reservation_id=p_id;end if;
 insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,old_value,new_value) values(p_actor,'update','reservation',p_id,to_jsonb(old),(select to_jsonb(r) from public.reservations r where id=p_id));
end $$;

grant execute on function public.fixed_booking_times(date), public.fixed_booking_end(date,time) to service_role;
