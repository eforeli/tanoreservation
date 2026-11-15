-- Shared by all production instances; store a client hash instead of an IP.
create table public.public_booking_rate_limits (
  client_hash text primary key,
  window_start timestamptz not null,
  attempts integer not null check (attempts between 1 and 12)
);
alter table public.public_booking_rate_limits enable row level security;
revoke all on public.public_booking_rate_limits from public, anon, authenticated;
create index public_booking_rate_limits_window on public.public_booking_rate_limits(window_start);

create function public.allow_public_booking(p_client_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  current_window timestamptz := pg_catalog.date_bin(interval '15 minutes', clock_timestamp(), '2000-01-01 UTC'::timestamptz);
  admitted boolean;
begin
  if p_client_hash is null or p_client_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  -- Amortize indexed cleanup on ordinary traffic; keep only recent windows.
  if random() < 0.02 then
    delete from public.public_booking_rate_limits where window_start < current_window - interval '1 day';
  end if;
  -- Increment and enforce the cap atomically, including concurrent requests.
  insert into public.public_booking_rate_limits as limits (client_hash, window_start, attempts)
  values (p_client_hash, current_window, 1)
  on conflict (client_hash) do update
  set window_start = excluded.window_start,
      attempts = case when limits.window_start < excluded.window_start then 1 else limits.attempts + 1 end
  where limits.window_start < excluded.window_start
     or (limits.window_start = excluded.window_start and limits.attempts < 12)
  returning true into admitted;

  return coalesce(admitted, false);
end
$$;
revoke all on function public.allow_public_booking(text) from public, anon, authenticated;
grant execute on function public.allow_public_booking(text) to service_role;
