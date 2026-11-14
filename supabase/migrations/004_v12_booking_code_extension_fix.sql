create or replace function public.generate_booking_code()
returns text language plpgsql volatile security invoker set search_path=public as $$
declare candidate text; bytes bytea; alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; idx int; attempts int;
begin
 for attempts in 1..100 loop
  bytes := extensions.gen_random_bytes(6);
  candidate := '';
  for idx in 0..5 loop
   candidate := candidate || substr(alphabet, (get_byte(bytes,idx) % length(alphabet))+1, 1);
  end loop;
  if candidate ~ '[A-Z]' and candidate ~ '[0-9]' and not exists(select 1 from public.reservations where confirmation_code=candidate) then return candidate;end if;
 end loop;
 raise exception 'Unable to generate booking code';
end $$;
revoke all on function public.generate_booking_code() from public,anon,authenticated;
grant execute on function public.generate_booking_code() to service_role;