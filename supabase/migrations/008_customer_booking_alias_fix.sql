-- Fix PL/pgSQL variable/SQL alias ambiguity found in rollback-only integration tests.
create or replace function public.customer_get_booking(p_token_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.reservations%rowtype;
begin
 select booking.* into r from public.customer_booking_sessions s
 join public.reservations booking on booking.id=s.reservation_id
 where s.token_hash=p_token_hash and s.expires_at>now();
 if not found then raise exception 'session expired';end if;
 return public.customer_booking_json(r);
end $$;

create or replace function public.customer_available_slots(p_token_hash text,p_date date,p_party_size int)
returns text[] language plpgsql security definer set search_path=public as $$
declare r public.reservations%rowtype;s public.booking_settings%rowtype;
 seg jsonb; o time; c time;cur time; out_slots text[]:='{}';
begin
 select booking.* into r from public.customer_booking_sessions a
 join public.reservations booking on a.reservation_id=booking.id
 where a.token_hash=p_token_hash and a.expires_at>now();
 if not found then raise exception 'session expired';end if;
 if r.status<>'confirmed' or r.starts_at<=clock_timestamp() then raise exception 'not eligible';end if;
 select * into s from public.booking_settings where id=1;
 if p_party_size<1 or p_party_size>s.max_online_party_size then return out_slots;end if;
 for seg in select value from jsonb_array_elements(public.booking_day_periods(p_date)) loop
  o:=(seg->>'start')::time;c:=(seg->>'end')::time;cur:=o;
  while cur<=c loop
   if public.customer_valid_edit_slot(p_date,cur,p_party_size)
    and public.find_table_for_booking(
      (p_date::text||' '||cur::text)::timestamp at time zone 'Asia/Taipei',p_party_size,r.id
    ) is not null then out_slots:=array_append(out_slots,to_char(cur,'HH24:MI'));end if;
   cur:=cur+make_interval(mins=>s.slot_interval_minutes);
  end loop;
 end loop;
 return array(select distinct x from unnest(out_slots) x order by x);
end $$;

revoke execute on function public.customer_get_booking(text) from public,anon,authenticated;
revoke execute on function public.customer_available_slots(text,date,int) from public,anon,authenticated;
grant execute on function public.customer_get_booking(text) to service_role;
grant execute on function public.customer_available_slots(text,date,int) to service_role;
