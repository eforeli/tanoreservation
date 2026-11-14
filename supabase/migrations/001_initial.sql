-- Run once in Supabase SQL Editor. All exposed tables have RLS enabled with NO client policies.
create extension if not exists pgcrypto;
create table if not exists public.restaurant_tables(id uuid primary key default gen_random_uuid(),code text not null unique,base_capacity int not null,max_capacity int not null,is_active boolean not null default true,sort_order int not null default 0,created_at timestamptz not null default now(),check(base_capacity>0 and max_capacity>=base_capacity and max_capacity<=base_capacity+1));
create table if not exists public.booking_settings(id int primary key default 1 check(id=1),dining_minutes int not null default 90,buffer_minutes int not null default 20,slot_interval_minutes int not null default 30,booking_window_days int not null default 30,min_advance_minutes int not null default 120,extra_chairs_total int not null default 2,max_arrivals_per_slot int not null default 2,max_online_party_size int not null default 5,last_seating_offset_minutes int not null default 90,updated_at timestamptz default now());
create table if not exists public.weekly_business_hours(weekday int primary key check(weekday between 0 and 6),opens_at time,closes_at time,is_closed boolean not null default false);
create table if not exists public.special_business_hours(id uuid primary key default gen_random_uuid(),business_date date not null unique,opens_at time,closes_at time,is_closed boolean not null default false,notes text);
create table if not exists public.reservations(id uuid primary key default gen_random_uuid(),confirmation_code text not null unique default upper(substr(encode(gen_random_bytes(8),'hex'),1,10)),guest_name text not null,guest_phone text not null,party_size int not null check(party_size between 1 and 5),starts_at timestamptz not null,dining_ends_at timestamptz not null,table_released_at timestamptz not null,status text not null default 'confirmed' check(status in ('confirmed','seated','completed','no_show','cancelled')),notes text not null default '',source text not null default 'web' check(source in ('web','phone','line_message','walk_in','admin')),idempotency_key uuid unique,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),cancelled_at timestamptz,cancel_reason text);
create table if not exists public.reservation_tables(reservation_id uuid primary key references public.reservations(id) on delete restrict,table_id uuid not null references public.restaurant_tables(id));
create table if not exists public.table_blocks(id uuid primary key default gen_random_uuid(),table_id uuid not null references public.restaurant_tables(id),start_at timestamptz not null,end_at timestamptz,reason text not null default '',created_by uuid,created_at timestamptz not null default now(),released_at timestamptz,check(end_at is null or end_at>start_at));
create table if not exists public.admin_users(user_id uuid primary key references auth.users(id) on delete cascade,created_at timestamptz default now());
create table if not exists public.admin_audit_logs(id uuid primary key default gen_random_uuid(),actor_user_id uuid,action text not null,entity_type text not null,entity_id uuid,old_value jsonb,new_value jsonb,created_at timestamptz not null default now());
create index if not exists reservations_start_idx on public.reservations(starts_at) where status in ('confirmed','seated');
create index if not exists blocks_table_time_idx on public.table_blocks(table_id,start_at) where released_at is null;
insert into public.restaurant_tables(code,base_capacity,max_capacity,sort_order) values ('A1',2,3,1),('A2',2,2,2),('A3',2,3,3),('A4',4,5,4),('A5',4,5,5) on conflict(code) do nothing;
insert into public.booking_settings(id) values(1) on conflict(id) do nothing;
insert into public.weekly_business_hours(weekday,opens_at,closes_at,is_closed) values(0,null,null,true),(1,null,null,true),(2,'17:00','21:00',false),(3,'17:00','21:00',false),(4,'17:00','21:00',false),(5,'17:00','21:00',false),(6,'17:00','22:00',false) on conflict(weekday) do nothing;
-- NOTE PostgreSQL EXTRACT(dow): 0 Sun, 1 Mon, 2 Tue ... 6 Sat.
do $$ declare n text; begin foreach n in array array['restaurant_tables','booking_settings','weekly_business_hours','special_business_hours','reservations','reservation_tables','table_blocks','admin_users','admin_audit_logs'] loop execute format('alter table public.%I enable row level security',n); end loop; end $$;
-- Enforce no direct user access; only server-side service role is allowed.
revoke all on all tables in schema public from anon,authenticated;

create or replace function public.booking_valid_slot(p_date date,p_clock time,p_party int) returns boolean language plpgsql stable set search_path=public as $$
declare s public.booking_settings%rowtype; o time; c time; closed boolean; daynum int; ts timestamptz;
begin
 select * into s from public.booking_settings where id=1;
 if p_party<1 or p_party>s.max_online_party_size then return false;end if;
 if p_date < (now() at time zone 'Asia/Taipei')::date or p_date > (now() at time zone 'Asia/Taipei')::date+s.booking_window_days then return false;end if;
 ts := (p_date::text||' '||p_clock::text)::timestamp at time zone 'Asia/Taipei';
 if ts < now()+make_interval(mins=>s.min_advance_minutes) then return false;end if;
 daynum:=extract(dow from p_date)::int;
 select opens_at,closes_at,is_closed into o,c,closed from public.weekly_business_hours where weekday=daynum;
 select coalesce(x.opens_at,o),coalesce(x.closes_at,c),x.is_closed into o,c,closed from public.special_business_hours x where x.business_date=p_date;
 if not found then select opens_at,closes_at,is_closed into o,c,closed from public.weekly_business_hours where weekday=daynum;end if;
 if closed or o is null or c is null or p_clock<o or p_clock>c-make_interval(mins=>s.last_seating_offset_minutes) then return false;end if;
 if mod((extract(epoch from (p_clock-o))/60)::int,s.slot_interval_minutes)<>0 then return false;end if;
 return true;
end $$;

-- Inventory resolver is invoked inside a day-scoped transaction lock when writing.
create or replace function public.find_table_for_booking(p_start timestamptz,p_party int,p_exclude uuid default null)
returns uuid language plpgsql stable set search_path=public as $$
declare s public.booking_settings%rowtype;t public.restaurant_tables%rowtype;finish timestamptz;chair_finish timestamptz;needed int;used int;pt timestamptz;begin
 select * into s from public.booking_settings where id=1;
 finish:=p_start+make_interval(mins=>s.dining_minutes+s.buffer_minutes);
 chair_finish:=p_start+make_interval(mins=>s.dining_minutes);
 if (select count(*) from public.reservations r where r.status in ('confirmed','seated') and r.id is distinct from p_exclude and r.starts_at=p_start)>=s.max_arrivals_per_slot then return null;end if;
 for t in select * from public.restaurant_tables where is_active and max_capacity>=p_party order by case when p_party<=2 then case code when 'A2' then 0 when 'A1' then 1 when 'A3' then 2 when 'A4' then 3 else 4 end when p_party=3 then case code when 'A4' then 0 when 'A5' then 1 when 'A1' then 2 when 'A3' then 3 else 4 end else case code when 'A4' then 0 else 1 end end,sort_order loop
  if exists(select 1 from public.reservations r join public.reservation_tables rt on rt.reservation_id=r.id where rt.table_id=t.id and r.status in ('confirmed','seated') and r.id is distinct from p_exclude and r.starts_at<finish and r.table_released_at>p_start) then continue;end if;
  if exists(select 1 from public.table_blocks b where b.table_id=t.id and b.released_at is null and b.start_at<finish and coalesce(b.end_at,'infinity'::timestamptz)>p_start) then continue;end if;
  needed:=greatest(0,p_party-t.base_capacity); if needed>s.extra_chairs_total then continue;end if;
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

create or replace function public.get_available_slots(p_date date,p_party_size int) returns text[] language plpgsql security definer set search_path=public as $$
declare s public.booking_settings%rowtype; o time; c time;cur time;list text[]:='{}'; d int;
begin
 select * into s from public.booking_settings where id=1;
 if p_party_size<1 or p_party_size>s.max_online_party_size then return list;end if;
 d:=extract(dow from p_date)::int;
 select opens_at,closes_at into o,c from public.weekly_business_hours where weekday=d;
 select coalesce(x.opens_at,o),coalesce(x.closes_at,c) into o,c from public.special_business_hours x where business_date=p_date;
 if not found then select opens_at,closes_at into o,c from public.weekly_business_hours where weekday=d;end if;
 if o is null or c is null then return list;end if;
 cur:=o;
 while cur<=c loop
  if public.booking_valid_slot(p_date,cur,p_party_size) and public.find_table_for_booking((p_date::text||' '||cur::text)::timestamp at time zone 'Asia/Taipei',p_party_size) is not null then list:=array_append(list,to_char(cur,'HH24:MI'));end if;
  cur:=cur+make_interval(mins=>s.slot_interval_minutes);
 end loop;
 return list;
end $$;

create or replace function public.create_booking(p_date date,p_time text,p_party_size int,p_name text,p_phone text,p_notes text,p_source text,p_key uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare start_ts timestamptz; t_id uuid; s public.booking_settings%rowtype; r public.reservations%rowtype;old public.reservations%rowtype;
begin
 if p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'not eligible';end if;
 if length(trim(p_name))<1 or length(p_name)>80 or length(p_phone)>20 or length(p_phone)<8 or length(coalesce(p_notes,''))>500 then raise exception 'not eligible';end if;
 if p_source not in ('web','phone','line_message','walk_in','admin') then raise exception 'not eligible';end if;
 if p_source<>'web' and p_actor is null then raise exception 'not eligible';end if;
 -- Daily lock serializes all check+write operations on this calendar day.
 perform pg_advisory_xact_lock(hashtext('TANO:'||p_date::text));
 select * into old from public.reservations where idempotency_key=p_key;
 if found then
  if old.guest_phone<>p_phone or old.party_size<>p_party_size or old.starts_at<>((p_date::text||' '||p_time)::timestamp at time zone 'Asia/Taipei') then raise exception 'idempotency conflict';end if;
  return jsonb_build_object('confirmation_code',old.confirmation_code,'starts_at',old.starts_at,'party_size',old.party_size,'guest_name',old.guest_name);
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

-- Admin updates lock original and target days in deterministic order, do not remove original on failure.
create or replace function public.admin_update_booking(p_id uuid,p_date date,p_time text,p_party int,p_name text,p_phone text,p_notes text,p_status text,p_actor uuid)
returns void language plpgsql security definer set search_path=public as $$
declare old public.reservations%rowtype; new_start timestamptz;target uuid;s public.booking_settings%rowtype;day1 date;day2 date;
begin
 select * into old from public.reservations where id=p_id;if not found then raise exception 'not found';end if;
 if old.status='cancelled' or p_status not in ('confirmed','seated','completed','no_show') then raise exception 'invalid transition';end if;
 if length(trim(p_name))=0 or length(p_name)>80 or length(p_phone)<8 or length(p_phone)>20 or length(coalesce(p_notes,''))>500 then raise exception 'not eligible';end if;
 day1:=(old.starts_at at time zone 'Asia/Taipei')::date;day2:=p_date;
 perform pg_advisory_xact_lock(hashtext('TANO:'||least(day1,day2)::text));
 if day1<>day2 then perform pg_advisory_xact_lock(hashtext('TANO:'||greatest(day1,day2)::text));end if;
 if p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'not eligible';end if;
 if not public.booking_valid_slot(p_date,p_time::time,p_party) then raise exception 'not eligible';end if;
 new_start:=(p_date::text||' '||p_time)::timestamp at time zone 'Asia/Taipei';
 target:=public.find_table_for_booking(new_start,p_party,p_id);
 if target is null then raise exception 'unavailable';end if;
 select * into s from public.booking_settings where id=1;
 update public.reservations set guest_name=trim(p_name),guest_phone=trim(p_phone),notes=coalesce(p_notes,''),party_size=p_party,starts_at=new_start,dining_ends_at=new_start+make_interval(mins=>s.dining_minutes),table_released_at=new_start+make_interval(mins=>s.dining_minutes+s.buffer_minutes),status=p_status,updated_at=now() where id=p_id;
 update public.reservation_tables set table_id=target where reservation_id=p_id;
 insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,old_value,new_value) values(p_actor,'update','reservation',p_id,to_jsonb(old),(select to_jsonb(r) from public.reservations r where id=p_id));
end $$;

create or replace function public.admin_cancel_booking(p_id uuid,p_reason text,p_actor uuid) returns void language plpgsql security definer set search_path=public as $$
declare old public.reservations%rowtype;begin
 select * into old from public.reservations where id=p_id;if not found then raise exception 'not found';end if;
 perform pg_advisory_xact_lock(hashtext('TANO:'||(old.starts_at at time zone 'Asia/Taipei')::date::text));
 select * into old from public.reservations where id=p_id for update;
 if old.status='cancelled' then return;end if;
 update public.reservations set status='cancelled',cancelled_at=now(),cancel_reason=left(p_reason,300),updated_at=now() where id=p_id;
 insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,old_value,new_value) values(p_actor,'cancel','reservation',p_id,to_jsonb(old),(select to_jsonb(r) from public.reservations r where id=p_id));
end $$;

create or replace function public.admin_block_table(p_table_code text,p_start timestamptz,p_end timestamptz,p_reason text,p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare tid uuid;block_id uuid;conflicts jsonb;begin
 if p_end is not null and p_end<=p_start then raise exception 'invalid period';end if;
 select id into tid from public.restaurant_tables where code=p_table_code;if tid is null then raise exception 'unknown table';end if;
 perform pg_advisory_xact_lock(hashtext('TANO:'||(p_start at time zone 'Asia/Taipei')::date::text));
 insert into public.table_blocks(table_id,start_at,end_at,reason,created_by) values(tid,p_start,p_end,left(p_reason,500),p_actor) returning id into block_id;
 select coalesce(jsonb_agg(jsonb_build_object('confirmation_code',r.confirmation_code,'starts_at',r.starts_at,'guest_name',r.guest_name)),'[]'::jsonb) into conflicts from public.reservations r join public.reservation_tables rt on rt.reservation_id=r.id where rt.table_id=tid and r.status in ('confirmed','seated') and r.starts_at<coalesce(p_end,'infinity'::timestamptz) and r.table_released_at>p_start;
 insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,new_value) values(p_actor,'block','table_block',block_id,jsonb_build_object('table',p_table_code,'start',p_start,'end',p_end,'reason',p_reason,'conflicts',conflicts));
 return jsonb_build_object('id',block_id,'conflicts',conflicts);
end $$;

create or replace function public.admin_unblock_table(p_id uuid,p_actor uuid) returns void language plpgsql security definer set search_path=public as $$
declare old public.table_blocks%rowtype;begin
 select * into old from public.table_blocks where id=p_id;if not found then raise exception 'not found';end if;
 perform pg_advisory_xact_lock(hashtext('TANO:'||(old.start_at at time zone 'Asia/Taipei')::date::text));
 update public.table_blocks set released_at=now() where id=p_id and released_at is null;
 insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,old_value) values(p_actor,'unblock','table_block',p_id,to_jsonb(old));
end $$;

-- These functions use SECURITY DEFINER and MUST NOT be callable by browser roles.
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.get_available_slots(date,int) to service_role;
grant execute on function public.create_booking(date,text,int,text,text,text,text,uuid,uuid) to service_role;
grant execute on function public.admin_update_booking(uuid,date,text,int,text,text,text,text,uuid) to service_role;
grant execute on function public.admin_cancel_booking(uuid,text,uuid) to service_role;
grant execute on function public.admin_block_table(text,timestamptz,timestamptz,text,uuid) to service_role;
grant execute on function public.admin_unblock_table(uuid,uuid) to service_role;
