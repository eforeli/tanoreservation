-- Prevent duplicate online bookings for the same Taiwan calendar day and phone.
-- This guard runs after the existing per-day advisory transaction lock, so
-- concurrent submissions cannot both create an active booking.
-- Existing idempotency lookup deliberately stays before this guard.
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
 -- Guard only online creations; manual admin entry remains available for exceptional cases.
 -- Existing confirmed/seated reservations from any source count against this check.
 if p_source='web' and exists(
  select 1 from public.reservations existing
  where existing.guest_phone=trim(p_phone)
   and existing.status in ('confirmed','seated')
   and existing.starts_at >= (p_date::timestamp at time zone 'Asia/Taipei')
   and existing.starts_at < ((p_date+1)::timestamp at time zone 'Asia/Taipei')
 ) then
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


revoke execute on function public.create_booking(date,text,int,text,text,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.create_booking(date,text,int,text,text,text,text,uuid,uuid) to service_role;
create index if not exists reservations_active_phone_start_idx
 on public.reservations(guest_phone,starts_at)
 where status in ('confirmed','seated');
