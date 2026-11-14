-- TANO V1.8: immutable guest identity on self-service updates and consolidated reservation logs.
create or replace function public.customer_update_booking(
 p_token_hash text,p_date date,p_time text,p_party int,
 p_name text,p_phone text,p_notes text,p_expected_updated_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public as $$
declare old public.reservations%rowtype; r public.reservations%rowtype;
 target uuid; s public.booking_settings%rowtype;
 new_start timestamptz;day1 date;day2 date; session_res uuid; changed_slot boolean;
begin
 select a.reservation_id into session_res from public.customer_booking_sessions a
 where a.token_hash=p_token_hash and a.expires_at>now();
 if session_res is null then raise exception 'session expired';end if;
 select * into old from public.reservations where id=session_res;
 if not found then raise exception 'session expired';end if;
 day1:=(old.starts_at at time zone 'Asia/Taipei')::date;day2:=p_date;
 -- Same deterministic day locking order as admin_update_booking.
 perform pg_advisory_xact_lock(hashtext('TANO:'||least(day1,day2)::text));
 if day1<>day2 then perform pg_advisory_xact_lock(hashtext('TANO:'||greatest(day1,day2)::text));end if;
 select * into old from public.reservations where id=session_res for update;
 if (old.starts_at at time zone 'Asia/Taipei')::date<>day1 then raise exception 'reservation changed';end if;
 if old.updated_at is distinct from p_expected_updated_at then raise exception 'reservation changed';end if;
 if p_name is distinct from old.guest_name or p_phone is distinct from old.guest_phone then raise exception 'identity immutable';end if;
 if old.status<>'confirmed' or old.starts_at<=clock_timestamp() then raise exception 'not eligible';end if;
 if p_date is null or p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or p_party<1 or p_party>5 or length(trim(p_name))<1 or length(p_name)>80
  or p_phone !~ '^09[0-9]{8}$' or length(coalesce(p_notes,''))>500
  then raise exception 'not eligible';end if;
 new_start:=(p_date::text||' '||p_time)::timestamp at time zone 'Asia/Taipei';
 if new_start<=clock_timestamp() then raise exception 'not eligible';end if;
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



-- Unified, read-only admin reporting view; base tables retain RLS restrictions.
create or replace view public.reservation_change_log
with (security_invoker=true) as
select
 l.id, l.reservation_id, r.confirmation_code, r.created_at as booking_created_at,
 coalesce(l.new_value->>'guest_name',l.old_value->>'guest_name',r.guest_name) as guest_name,
 coalesce(l.new_value->>'guest_phone',l.old_value->>'guest_phone',r.guest_phone) as guest_phone,
 l.old_value->>'starts_at' as before_starts_at,
 (l.old_value->>'party_size')::int as before_party_size,
 l.new_value->>'starts_at' as after_starts_at,
 (l.new_value->>'party_size')::int as after_party_size,
 l.action, l.created_at as changed_at, 'customer'::text as actor
from public.customer_booking_audit_logs l
join public.reservations r on r.id=l.reservation_id
where l.action in ('update','cancel') and l.created_at>=now()-interval '30 days'
union all
select
 l.id, l.entity_id as reservation_id, r.confirmation_code, r.created_at as booking_created_at,
 coalesce(l.new_value->>'guest_name',l.old_value->>'guest_name',r.guest_name) as guest_name,
 coalesce(l.new_value->>'guest_phone',l.old_value->>'guest_phone',r.guest_phone) as guest_phone,
 l.old_value->>'starts_at' as before_starts_at,
 (l.old_value->>'party_size')::int as before_party_size,
 l.new_value->>'starts_at' as after_starts_at,
 (l.new_value->>'party_size')::int as after_party_size,
 l.action, l.created_at as changed_at, 'admin'::text as actor
from public.admin_audit_logs l
join public.reservations r on r.id=l.entity_id
where l.entity_type='reservation' and l.action in ('update','cancel')
 and l.created_at>=now()-interval '30 days';
revoke all on public.reservation_change_log from public,anon,authenticated;
grant select on public.reservation_change_log to service_role;
create index if not exists admin_reservation_log_time_idx
 on public.admin_audit_logs(created_at desc) where entity_type='reservation' and action in ('update','cancel');
create index if not exists customer_reservation_log_time_idx
 on public.customer_booking_audit_logs(created_at desc);

revoke execute on function public.customer_update_booking(text,date,text,int,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.customer_update_booking(text,date,text,int,text,text,text,timestamptz) to service_role;
