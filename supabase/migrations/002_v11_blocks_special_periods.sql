-- TANO reservation V1.1: safe upgrade; preserves existing reservations and historical records.
alter table public.special_business_hours add column if not exists periods jsonb;
update public.special_business_hours set periods=jsonb_build_array(jsonb_build_object('start',to_char(opens_at,'HH24:MI'),'end',to_char(closes_at,'HH24:MI'))) where periods is null and not is_closed and opens_at is not null and closes_at is not null;

CREATE OR REPLACE FUNCTION public.admin_block_table(p_table_code text, p_start timestamp with time zone, p_end timestamp with time zone, p_reason text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare tid uuid;block_id uuid;
begin
 if p_end is not null and p_end<=p_start then raise exception 'invalid period';end if;
 select id into tid from public.restaurant_tables where code=p_table_code and is_active;
 if tid is null then raise exception 'unknown table';end if;
 perform pg_advisory_xact_lock(hashtext('TANO:'||(p_start at time zone 'Asia/Taipei')::date::text));
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
declare old public.table_blocks%rowtype;tid uuid;d1 date;d2 date;
begin
 if p_end is not null and p_end<=p_start then raise exception 'invalid period';end if;
 select * into old from public.table_blocks where id=p_id and released_at is null;
 if not found then raise exception 'not found';end if;
 select id into tid from public.restaurant_tables where code=p_table_code and is_active;
 if tid is null then raise exception 'unknown table';end if;
 d1:=(old.start_at at time zone 'Asia/Taipei')::date;d2:=(p_start at time zone 'Asia/Taipei')::date;
 perform pg_advisory_xact_lock(hashtext('TANO:'||least(d1,d2)::text));
 if d1<>d2 then perform pg_advisory_xact_lock(hashtext('TANO:'||greatest(d1,d2)::text));end if;
 if exists(select 1 from public.reservations r join public.reservation_tables rt on rt.reservation_id=r.id where rt.table_id=tid and r.status in ('confirmed','seated') and r.starts_at<coalesce(p_end,'infinity'::timestamptz) and r.table_released_at>p_start) then raise exception '已有訂位，無法鎖桌！';end if;
 if exists(select 1 from public.table_blocks b where b.id<>p_id and b.table_id=tid and b.released_at is null and b.start_at<coalesce(p_end,'infinity'::timestamptz) and coalesce(b.end_at,'infinity'::timestamptz)>p_start) then raise exception '該時段已有鎖桌紀錄';end if;
 update public.table_blocks set table_id=tid,start_at=p_start,end_at=p_end,reason=left(p_reason,500) where id=p_id;
 insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,old_value,new_value) values(p_actor,'update','table_block',p_id,to_jsonb(old),jsonb_build_object('table',p_table_code,'start',p_start,'end',p_end,'reason',p_reason));
end $function$
;

CREATE OR REPLACE FUNCTION public.booking_valid_slot(p_date date, p_clock time without time zone, p_party integer)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare s public.booking_settings%rowtype; o time; c time; closed boolean; daynum int; ts timestamptz; sp public.special_business_hours%rowtype; segment jsonb; found_segment boolean:=false;
begin
 select * into s from public.booking_settings where id=1;
 if p_party<1 or p_party>s.max_online_party_size then return false;end if;
 if p_date<(now() at time zone 'Asia/Taipei')::date or p_date>(now() at time zone 'Asia/Taipei')::date+s.booking_window_days then return false;end if;
 ts:=(p_date::text||' '||p_clock::text)::timestamp at time zone 'Asia/Taipei';
 if ts<now()+make_interval(mins=>s.min_advance_minutes) then return false;end if;
 select * into sp from public.special_business_hours where business_date=p_date;
 if found then
  if sp.is_closed then return false;end if;
  if sp.periods is not null and jsonb_array_length(sp.periods)>0 then
   for segment in select value from jsonb_array_elements(sp.periods) loop
    o:=(segment->>'start')::time;c:=(segment->>'end')::time;
    if p_clock>=o and p_clock<=c-make_interval(mins=>s.last_seating_offset_minutes) and mod((extract(epoch from (p_clock-o))/60)::int,s.slot_interval_minutes)=0 then found_segment:=true; exit;end if;
   end loop;
   return found_segment;
  end if;
  o:=sp.opens_at;c:=sp.closes_at;closed:=sp.is_closed;
 else
  daynum:=extract(dow from p_date)::int;
  select opens_at,closes_at,is_closed into o,c,closed from public.weekly_business_hours where weekday=daynum;
 end if;
 if closed or o is null or c is null or p_clock<o or p_clock>c-make_interval(mins=>s.last_seating_offset_minutes) then return false;end if;
 return mod((extract(epoch from (p_clock-o))/60)::int,s.slot_interval_minutes)=0;
end $function$
;

CREATE OR REPLACE FUNCTION public.get_available_slots(p_date date, p_party_size integer)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.booking_settings%rowtype;o time;c time;cur time;list text[]:='{}';sp public.special_business_hours%rowtype;seg jsonb;segments jsonb;
begin
 select * into s from public.booking_settings where id=1;
 if p_party_size<1 or p_party_size>s.max_online_party_size then return list;end if;
 select * into sp from public.special_business_hours where business_date=p_date;
 if found then
  if sp.is_closed then return list;end if;
  segments:=coalesce(sp.periods,jsonb_build_array(jsonb_build_object('start',to_char(sp.opens_at,'HH24:MI'),'end',to_char(sp.closes_at,'HH24:MI'))));
 else
  select opens_at,closes_at into o,c from public.weekly_business_hours where weekday=extract(dow from p_date)::int;
  if o is null or c is null then return list;end if;
  segments:=jsonb_build_array(jsonb_build_object('start',to_char(o,'HH24:MI'),'end',to_char(c,'HH24:MI')));
 end if;
 for seg in select value from jsonb_array_elements(segments) loop
  o:=(seg->>'start')::time;c:=(seg->>'end')::time;cur:=o;
  while cur<=c loop
   if public.booking_valid_slot(p_date,cur,p_party_size) and public.find_table_for_booking((p_date::text||' '||cur::text)::timestamp at time zone 'Asia/Taipei',p_party_size) is not null then list:=array_append(list,to_char(cur,'HH24:MI'));end if;
   cur:=cur+make_interval(mins=>s.slot_interval_minutes);
  end loop;
 end loop;
 return array(select distinct x from unnest(list) x order by x);
end $function$
;

revoke execute on function public.admin_edit_block_table(uuid,text,timestamptz,timestamptz,text,uuid) from public,anon,authenticated;
grant execute on function public.admin_edit_block_table(uuid,text,timestamptz,timestamptz,text,uuid) to service_role;
revoke execute on function public.admin_block_table(text,timestamptz,timestamptz,text,uuid) from public,anon,authenticated;
grant execute on function public.admin_block_table(text,timestamptz,timestamptz,text,uuid) to service_role;
revoke execute on function public.booking_valid_slot(date,time,int) from public,anon,authenticated;
grant execute on function public.booking_valid_slot(date,time,int) to service_role;
revoke execute on function public.get_available_slots(date,int) from public,anon,authenticated;
grant execute on function public.get_available_slots(date,int) to service_role;
