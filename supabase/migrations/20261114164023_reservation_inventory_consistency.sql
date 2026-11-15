-- Inventory is shared across only five tables, including overnight and indefinite locks.
-- Serialize writes on one transaction-scoped lock before checking capacity or reading a row
-- to update. Availability reads remain lock-free and writes revalidate before committing.
create or replace function public.lock_reservation_inventory()
returns void language sql set search_path='' as $$
 select pg_catalog.pg_advisory_xact_lock(55267219, 1);
$$;
revoke all on function public.lock_reservation_inventory() from public,anon,authenticated;
grant execute on function public.lock_reservation_inventory() to service_role;

create or replace function public.lock_reservation_configuration()
returns trigger language plpgsql set search_path='' as $$
begin
 perform public.lock_reservation_inventory();
 return null;
end;
$$;
revoke all on function public.lock_reservation_configuration() from public,anon,authenticated;

-- The existing REST settings routes participate in the same lock, including upserts.
create trigger booking_settings_inventory_lock
before insert or update or delete on public.booking_settings
for each statement execute function public.lock_reservation_configuration();
create trigger weekly_hours_inventory_lock
before insert or update or delete on public.weekly_business_hours
for each statement execute function public.lock_reservation_configuration();
create trigger special_hours_inventory_lock
before insert or update or delete on public.special_business_hours
for each statement execute function public.lock_reservation_configuration();
create trigger restaurant_tables_inventory_lock
before insert or update or delete on public.restaurant_tables
for each statement execute function public.lock_reservation_configuration();

create or replace function public.has_active_phone_booking(p_date date,p_phone text,p_exclude uuid)
returns boolean language sql stable set search_path='' as $$
 select exists (
  select 1 from public.reservations
  where guest_phone=trim(p_phone) and status in ('confirmed','seated')
    and id is distinct from p_exclude
    and starts_at >= (p_date::timestamp at time zone 'Asia/Taipei')
    and starts_at < ((p_date+1)::timestamp at time zone 'Asia/Taipei')
 );
$$;
revoke all on function public.has_active_phone_booking(date,text,uuid) from public,anon,authenticated;

-- Bounded timestamps avoid TIME arithmetic wrapping back to midnight.
create or replace function public.booking_slot_candidates(p_date date,p_interval int)
returns table (candidate timestamp) language sql stable set search_path='' as $$
 select distinct slot
 from jsonb_array_elements(public.booking_day_periods(p_date)) as period
 cross join lateral generate_series(
  p_date+(period->>'start')::time,
  p_date+(period->>'end')::time,
  make_interval(mins=>nullif(greatest(p_interval,0),0))
 ) as slots(slot)
 where slot < p_date+interval '1 day'
 order by slot;
$$;
revoke all on function public.booking_slot_candidates(date,int) from public,anon,authenticated;


create or replace function public.find_table_for_booking(p_start timestamptz,p_party int,p_exclude uuid default null)
returns uuid language plpgsql stable set search_path=public as $$
declare s public.booking_settings%rowtype;t public.restaurant_tables%rowtype;finish timestamptz;chair_finish timestamptz;needed int;begin
 select * into s from public.booking_settings where id=1;
 finish:=p_start+make_interval(mins=>s.dining_minutes+s.buffer_minutes);
 chair_finish:=p_start+make_interval(mins=>s.dining_minutes);
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
 select slot_interval_minutes into step from public.booking_settings where id=1;
 for slot in select candidate from public.booking_slot_candidates(p_date,step) loop
  if public.booking_valid_slot(p_date,slot::time,p_party_size) then
   had_eligible:=true;
   if public.find_table_for_booking(slot at time zone 'Asia/Taipei',p_party_size) is not null then
    return 'available';
   end if;
  end if;
 end loop;
 if had_eligible then return 'full';end if;
 return 'unavailable';
end $$;

create or replace function public.get_available_slots(p_date date,p_party_size int)
returns text[] language sql security definer set search_path='' as $$
 select coalesce(array_agg(to_char(candidate,'HH24:MI') order by candidate),'{}')
 from public.booking_settings s
 cross join lateral public.booking_slot_candidates(p_date,s.slot_interval_minutes)
 where s.id=1 and public.booking_valid_slot(p_date,candidate::time,p_party_size)
   and public.find_table_for_booking(candidate at time zone 'Asia/Taipei',p_party_size) is not null;
$$;

create or replace function public.customer_available_slots(p_token_hash text,p_date date,p_party_size int)
returns text[] language plpgsql security definer set search_path='' as $$
declare r public.reservations%rowtype; available text[];
begin
 select booking.* into r
 from public.customer_booking_sessions a join public.reservations booking on a.reservation_id=booking.id
 where a.token_hash=p_token_hash and a.expires_at>now();
 if not found then raise exception 'session expired';end if;
 if r.status<>'confirmed' or r.starts_at<=clock_timestamp() then raise exception 'not eligible';end if;
 select coalesce(array_agg(to_char(candidate,'HH24:MI') order by candidate),'{}') into available
 from public.booking_settings s
 cross join lateral public.booking_slot_candidates(p_date,s.slot_interval_minutes)
 where s.id=1 and public.customer_valid_edit_slot(p_date,candidate::time,p_party_size)
   and public.find_table_for_booking(candidate at time zone 'Asia/Taipei',p_party_size,r.id) is not null;
 return available;
end $$;


create or replace function public.create_booking(p_date date,p_time text,p_party_size int,p_name text,p_phone text,p_notes text,p_source text,p_key uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare start_ts timestamptz; t_id uuid; s public.booking_settings%rowtype; r public.reservations%rowtype;old public.reservations%rowtype;
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
 insert into public.reservations(guest_name,guest_phone,party_size,starts_at,dining_ends_at,table_released_at,notes,source,idempotency_key) values(trim(p_name),trim(p_phone),p_party_size,start_ts,start_ts+make_interval(mins=>s.dining_minutes),start_ts+make_interval(mins=>s.dining_minutes+s.buffer_minutes),coalesce(p_notes,''),p_source,p_key) returning * into r;
 insert into public.reservation_tables(reservation_id,table_id) values(r.id,t_id);
 if p_actor is not null then insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,new_value) values(p_actor,'create','reservation',r.id,to_jsonb(r));end if;
 return jsonb_build_object('confirmation_code',r.confirmation_code,'starts_at',r.starts_at,'party_size',r.party_size,'guest_name',r.guest_name);
end $$;

create or replace function public.customer_update_booking(
 p_token_hash text,p_date date,p_time text,p_party int,
 p_name text,p_phone text,p_notes text,p_expected_updated_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public as $$
declare old public.reservations%rowtype; r public.reservations%rowtype;
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
 update public.reservations set
  notes=coalesce(p_notes,''),
  party_size=p_party,starts_at=new_start,
  dining_ends_at=case when changed_slot then new_start+make_interval(mins=>s.dining_minutes) else old.dining_ends_at end,
  table_released_at=case when changed_slot then new_start+make_interval(mins=>s.dining_minutes+s.buffer_minutes) else old.table_released_at end,
  updated_at=clock_timestamp()
 where id=old.id returning * into r;
 if changed_slot then update public.reservation_tables set table_id=target where reservation_id=old.id;end if;
 insert into public.customer_booking_audit_logs(reservation_id,action,old_value,new_value)
 values(old.id,'update',public.customer_booking_json(old),public.customer_booking_json(r));
 -- Invalidate token on success: old phone must not retain access.
 delete from public.customer_booking_sessions where reservation_id=old.id;
 return public.customer_booking_json(r);
end $$;

create or replace function public.customer_cancel_booking(p_token_hash text,p_expected_updated_at timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare old public.reservations%rowtype;r public.reservations%rowtype;session_res uuid;
begin
 perform public.lock_reservation_inventory();
 select reservation_id into session_res from public.customer_booking_sessions
 where token_hash=p_token_hash and expires_at>now();
 if session_res is null then raise exception 'session expired';end if;
 select * into old from public.reservations where id=session_res for update;
 if not found then raise exception 'session expired';end if;
 if old.updated_at is distinct from p_expected_updated_at then raise exception 'reservation changed';end if;
 if old.status<>'confirmed' or old.starts_at<=clock_timestamp() then raise exception 'not eligible';end if;
 update public.reservations set status='cancelled',cancelled_at=now(),
  cancel_reason='顧客自行取消',updated_at=clock_timestamp()
 where id=old.id returning * into r;
 insert into public.customer_booking_audit_logs(reservation_id,action,old_value,new_value)
 values(old.id,'cancel',public.customer_booking_json(old),public.customer_booking_json(r));
 delete from public.customer_booking_sessions where reservation_id=old.id;
 return public.customer_booking_json(r);
end $$;

create or replace function public.admin_update_booking_versioned(p_id uuid,p_date date,p_time text,p_party int,p_name text,p_phone text,p_notes text,p_status text,p_actor uuid,p_expected_updated_at timestamptz)
returns void language plpgsql security definer set search_path=public as $$
declare old public.reservations%rowtype; new_start timestamptz;target uuid;s public.booking_settings%rowtype;changed_slot boolean;
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
 update public.reservations set
  guest_name=trim(p_name),guest_phone=trim(p_phone),notes=coalesce(p_notes,''),party_size=p_party,
  starts_at=new_start,status=p_status,updated_at=clock_timestamp(),
  dining_ends_at=case when changed_slot then new_start+make_interval(mins=>s.dining_minutes) else old.dining_ends_at end,
  table_released_at=case when changed_slot then new_start+make_interval(mins=>s.dining_minutes+s.buffer_minutes) else old.table_released_at end
 where id=p_id;
 if changed_slot then update public.reservation_tables set table_id=target where reservation_id=p_id;end if;
 insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,old_value,new_value) values(p_actor,'update','reservation',p_id,to_jsonb(old),(select to_jsonb(r) from public.reservations r where id=p_id));
end $$;

revoke all on function public.admin_update_booking_versioned(uuid,date,text,int,text,text,text,text,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.admin_update_booking_versioned(uuid,date,text,int,text,text,text,text,uuid,timestamptz) to service_role;

-- Keep the deployed API compatible while the app switches to the versioned write.
create or replace function public.admin_update_booking(p_id uuid,p_date date,p_time text,p_party int,p_name text,p_phone text,p_notes text,p_status text,p_actor uuid)
returns void language sql security definer set search_path='' as $$
 select public.admin_update_booking_versioned(p_id,p_date,p_time,p_party,p_name,p_phone,p_notes,p_status,p_actor,null);
$$;


create or replace function public.admin_cancel_booking(p_id uuid,p_reason text,p_actor uuid) returns void language plpgsql security definer set search_path=public as $$
declare old public.reservations%rowtype;begin
 perform public.lock_reservation_inventory();
 select * into old from public.reservations where id=p_id for update;
 if not found then raise exception 'not found';end if;
 if old.status='cancelled' then return;end if;
 update public.reservations set status='cancelled',cancelled_at=now(),cancel_reason=left(p_reason,300),updated_at=clock_timestamp() where id=p_id;
 insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,old_value,new_value) values(p_actor,'cancel','reservation',p_id,to_jsonb(old),(select to_jsonb(r) from public.reservations r where id=p_id));
end $$;

CREATE OR REPLACE FUNCTION public.admin_block_table(p_table_code text, p_start timestamp with time zone, p_end timestamp with time zone, p_reason text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare tid uuid;block_id uuid;
begin
 perform public.lock_reservation_inventory();
 if p_end is not null and p_end<=p_start then raise exception 'invalid period';end if;
 select id into tid from public.restaurant_tables where code=p_table_code and is_active;
 if tid is null then raise exception 'unknown table';end if;
 if exists(select 1 from public.reservations r join public.reservation_tables rt on rt.reservation_id=r.id where rt.table_id=tid and r.status in ('confirmed','seated') and r.starts_at<coalesce(p_end,'infinity'::timestamptz) and r.table_released_at>p_start) then raise exception '已有訂位，無法鎖桌！';end if;
 if exists(select 1 from public.table_blocks b where b.table_id=tid and b.released_at is null and b.start_at<coalesce(p_end,'infinity'::timestamptz) and coalesce(b.end_at,'infinity'::timestamptz)>p_start) then raise exception '該時段已有鎖桌紀錄';end if;
 insert into public.table_blocks(table_id,start_at,end_at,reason,created_by) values(tid,p_start,p_end,left(p_reason,500),p_actor) returning id into block_id;
 insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,new_value) values(p_actor,'block','table_block',block_id,jsonb_build_object('table',p_table_code,'start',p_start,'end',p_end,'reason',p_reason));
 return jsonb_build_object('id',block_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_edit_block_table(p_id uuid, p_table_code text, p_start timestamp with time zone, p_end timestamp with time zone, p_reason text, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare old public.table_blocks%rowtype;tid uuid;
begin
 perform public.lock_reservation_inventory();
 if p_end is not null and p_end<=p_start then raise exception 'invalid period';end if;
 select * into old from public.table_blocks where id=p_id and released_at is null;
 if not found then raise exception 'not found';end if;
 select id into tid from public.restaurant_tables where code=p_table_code and is_active;
 if tid is null then raise exception 'unknown table';end if;
 if exists(select 1 from public.reservations r join public.reservation_tables rt on rt.reservation_id=r.id where rt.table_id=tid and r.status in ('confirmed','seated') and r.starts_at<coalesce(p_end,'infinity'::timestamptz) and r.table_released_at>p_start) then raise exception '已有訂位，無法鎖桌！';end if;
 if exists(select 1 from public.table_blocks b where b.id<>p_id and b.table_id=tid and b.released_at is null and b.start_at<coalesce(p_end,'infinity'::timestamptz) and coalesce(b.end_at,'infinity'::timestamptz)>p_start) then raise exception '該時段已有鎖桌紀錄';end if;
 update public.table_blocks set table_id=tid,start_at=p_start,end_at=p_end,reason=left(p_reason,500) where id=p_id;
 insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,old_value,new_value) values(p_actor,'update','table_block',p_id,to_jsonb(old),jsonb_build_object('table',p_table_code,'start',p_start,'end',p_end,'reason',p_reason));
end $function$
;

create or replace function public.admin_unblock_table(p_id uuid,p_actor uuid) returns void language plpgsql security definer set search_path=public as $$
declare old public.table_blocks%rowtype;begin
 perform public.lock_reservation_inventory();
 select * into old from public.table_blocks where id=p_id;if not found then raise exception 'not found';end if;
 if old.released_at is not null then return;end if;
 update public.table_blocks set released_at=now() where id=p_id;
 insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,old_value) values(p_actor,'unblock','table_block',p_id,to_jsonb(old));
end $$;
