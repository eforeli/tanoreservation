-- Customer self-service reservation management. Run AFTER 006.
-- All RPCs are service-role only; browser roles cannot call them.
create table if not exists public.customer_booking_sessions (
 token_hash text primary key,
 reservation_id uuid not null references public.reservations(id) on delete cascade,
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
create index if not exists customer_booking_sessions_expiry_idx on public.customer_booking_sessions(expires_at);
alter table public.customer_booking_sessions enable row level security;
revoke all on public.customer_booking_sessions from anon, authenticated;

create table if not exists public.customer_booking_verify_attempts (
 id bigint generated always as identity primary key,
 ip_hash text not null,
 attempted_at timestamptz not null default now()
);
create index if not exists customer_booking_attempts_ip_idx on public.customer_booking_verify_attempts(ip_hash, attempted_at);
alter table public.customer_booking_verify_attempts enable row level security;
revoke all on public.customer_booking_verify_attempts from anon, authenticated;

create table if not exists public.customer_booking_audit_logs (
 id uuid primary key default gen_random_uuid(),
 reservation_id uuid not null references public.reservations(id) on delete restrict,
 action text not null check (action in ('update','cancel')),
 old_value jsonb,
 new_value jsonb,
 created_at timestamptz not null default now()
);
create index if not exists customer_booking_audit_reservation_idx on public.customer_booking_audit_logs(reservation_id,created_at);
alter table public.customer_booking_audit_logs enable row level security;
revoke all on public.customer_booking_audit_logs from anon, authenticated;

create or replace function public.customer_booking_json(p_r public.reservations)
returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object(
  'confirmation_code',p_r.confirmation_code,'guest_name',p_r.guest_name,
  'guest_phone',p_r.guest_phone,'party_size',p_r.party_size,
  'starts_at',p_r.starts_at,'notes',p_r.notes,'status',p_r.status,
  'updated_at',p_r.updated_at,
  'can_manage',(p_r.status='confirmed' and p_r.starts_at>now())
 )
$$;

create or replace function public.customer_verify_booking(p_code text,p_phone text,p_token_hash text,p_ip_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.reservations%rowtype; n integer;
begin
 if length(p_token_hash)<>64 or length(p_ip_hash)<>64 then raise exception 'invalid credentials';end if;
 -- Serialize rate counter per source. Allow at most 8 attempts per 15 minutes.
 perform pg_advisory_xact_lock(hashtext('verify:'||p_ip_hash));
 select count(*) into n from public.customer_booking_verify_attempts where ip_hash=p_ip_hash and attempted_at>now()-interval '15 minutes';
 if n>=8 then raise exception 'rate limited';end if;
 insert into public.customer_booking_verify_attempts(ip_hash) values(p_ip_hash);
 select * into r from public.reservations where confirmation_code=upper(trim(p_code)) and guest_phone=trim(p_phone);
 if not found then return null;end if;
 delete from public.customer_booking_sessions where reservation_id=r.id;
 insert into public.customer_booking_sessions(token_hash,reservation_id,expires_at)
 values(p_token_hash,r.id,now()+interval '15 minutes');
 return public.customer_booking_json(r);
end $$;

create or replace function public.customer_get_booking(p_token_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.reservations%rowtype;
begin
 select r.* into r from public.customer_booking_sessions s
 join public.reservations r on r.id=s.reservation_id
 where s.token_hash=p_token_hash and s.expires_at>now();
 if not found then raise exception 'session expired';end if;
 return public.customer_booking_json(r);
end $$;

create or replace function public.customer_available_slots(p_token_hash text,p_date date,p_party_size int)
returns text[] language plpgsql security definer set search_path=public as $$
declare r public.reservations%rowtype;s public.booking_settings%rowtype;
 seg jsonb; o time; c time;cur time; out_slots text[]:='{}';
begin
 select r.* into r from public.customer_booking_sessions a join public.reservations r on a.reservation_id=r.id
 where a.token_hash=p_token_hash and a.expires_at>now();
 if not found then raise exception 'session expired';end if;
 if r.status<>'confirmed' or r.starts_at<=now() then raise exception 'not eligible';end if;
 select * into s from public.booking_settings where id=1;
 if p_party_size<1 or p_party_size>s.max_online_party_size then return out_slots;end if;
 for seg in select value from jsonb_array_elements(public.booking_day_periods(p_date)) loop
  o:=(seg->>'start')::time;c:=(seg->>'end')::time;cur:=o;
  while cur<=c loop
   if public.booking_valid_slot(p_date,cur,p_party_size)
    and public.find_table_for_booking(
      (p_date::text||' '||cur::text)::timestamp at time zone 'Asia/Taipei',p_party_size,r.id
    ) is not null then out_slots:=array_append(out_slots,to_char(cur,'HH24:MI'));end if;
   cur:=cur+make_interval(mins=>s.slot_interval_minutes);
  end loop;
 end loop;
 return array(select distinct x from unnest(out_slots) x order by x);
end $$;

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
 if old.status<>'confirmed' or old.starts_at<=now() then raise exception 'not eligible';end if;
 if p_date is null or p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or p_party<1 or p_party>5 or length(trim(p_name))<1 or length(p_name)>80
  or p_phone !~ '^09[0-9]{8}$' or length(coalesce(p_notes,''))>500
  then raise exception 'not eligible';end if;
 new_start:=(p_date::text||' '||p_time)::timestamp at time zone 'Asia/Taipei';
 if new_start<=now() then raise exception 'not eligible';end if;
 changed_slot := new_start<>old.starts_at or p_party<>old.party_size;
 if changed_slot then
  if not public.booking_valid_slot(p_date,p_time::time,p_party) then raise exception 'not eligible';end if;
  target:=public.find_table_for_booking(new_start,p_party,old.id);
  if target is null then raise exception 'unavailable';end if;
 end if;
 select * into s from public.booking_settings where id=1;
 update public.reservations set
  guest_name=trim(p_name),guest_phone=p_phone,notes=coalesce(p_notes,''),
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
declare old public.reservations%rowtype;r public.reservations%rowtype;session_res uuid;day1 date;
begin
 select reservation_id into session_res from public.customer_booking_sessions
 where token_hash=p_token_hash and expires_at>now();
 if session_res is null then raise exception 'session expired';end if;
 select * into old from public.reservations where id=session_res;
 if not found then raise exception 'session expired';end if;
 day1:=(old.starts_at at time zone 'Asia/Taipei')::date;
 perform pg_advisory_xact_lock(hashtext('TANO:'||day1::text));
 select * into old from public.reservations where id=session_res for update;
 if (old.starts_at at time zone 'Asia/Taipei')::date<>day1 then raise exception 'reservation changed';end if;
 if old.updated_at is distinct from p_expected_updated_at then raise exception 'reservation changed';end if;
 if old.status<>'confirmed' or old.starts_at<=now() then raise exception 'not eligible';end if;
 update public.reservations set status='cancelled',cancelled_at=now(),
  cancel_reason='顧客自行取消',updated_at=clock_timestamp()
 where id=old.id returning * into r;
 insert into public.customer_booking_audit_logs(reservation_id,action,old_value,new_value)
 values(old.id,'cancel',public.customer_booking_json(old),public.customer_booking_json(r));
 delete from public.customer_booking_sessions where reservation_id=old.id;
 return public.customer_booking_json(r);
end $$;

revoke execute on function public.customer_booking_json(public.reservations) from public,anon,authenticated;
revoke execute on function public.customer_verify_booking(text,text,text,text) from public,anon,authenticated;
revoke execute on function public.customer_get_booking(text) from public,anon,authenticated;
revoke execute on function public.customer_available_slots(text,date,int) from public,anon,authenticated;
revoke execute on function public.customer_update_booking(text,date,text,int,text,text,text,timestamptz) from public,anon,authenticated;
revoke execute on function public.customer_cancel_booking(text,timestamptz) from public,anon,authenticated;
grant execute on function public.customer_booking_json(public.reservations) to service_role;
grant execute on function public.customer_verify_booking(text,text,text,text) to service_role;
grant execute on function public.customer_get_booking(text) to service_role;
grant execute on function public.customer_available_slots(text,date,int) to service_role;
grant execute on function public.customer_update_booking(text,date,text,int,text,text,text,timestamptz) to service_role;
grant execute on function public.customer_cancel_booking(text,timestamptz) to service_role;
