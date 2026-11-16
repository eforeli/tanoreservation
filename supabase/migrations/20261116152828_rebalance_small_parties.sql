set local lock_timeout = '3s';

create table public.reservation_table_move_log (
 id bigint generated always as identity primary key,
 reservation_id uuid not null,
 from_table text not null,
 to_table text not null,
 reason text not null check (reason in ('cancellation', 'inventory_review')),
 moved_at timestamptz not null default clock_timestamp(),
 check (from_table <> to_table)
);
alter table public.reservation_table_move_log enable row level security;
revoke all on public.reservation_table_move_log from public, anon, authenticated, service_role;
grant select on public.reservation_table_move_log to service_role;

-- Reserve the same inventory lock used by reservation and table-block writes.
-- Only the assignment row changes. Use stored occupancy, including its buffer.
create function public.rebalance_small_parties(
 p_released_start timestamptz default null,
 p_released_end timestamptz default null
)
returns table (reservation_starts_at timestamptz, from_table text, to_table text)
language plpgsql
set search_path=''
as $$
declare
 booking record;
 destination record;
begin
 perform public.lock_reservation_inventory();

 for booking in
  select r.id, r.starts_at, r.table_released_at, r.party_size, rt.table_id, t.code
  from public.reservations r
  join public.reservation_tables rt on rt.reservation_id=r.id
  join public.restaurant_tables t on t.id=rt.table_id
  where r.status='confirmed' and r.starts_at>clock_timestamp()
    and r.party_size between 1 and 2 and t.code in ('A4','A5')
    and (p_released_start is null or r.table_released_at>p_released_start)
    and (p_released_end is null or r.starts_at<p_released_end)
  order by r.starts_at, r.created_at, r.id
 loop
  select small.id,small.code into destination
  from public.restaurant_tables small
  where small.code in ('A1','A2','A3') and small.is_active
    and small.base_capacity>=booking.party_size
    and not exists (
     select 1 from public.reservation_tables assigned
     join public.reservations occupied on occupied.id=assigned.reservation_id
     where assigned.table_id=small.id and occupied.status in ('confirmed','seated')
       and occupied.starts_at<booking.table_released_at
       and occupied.table_released_at>booking.starts_at
    )
    and not exists (
     select 1 from public.table_blocks blocked
     where blocked.table_id=small.id and blocked.released_at is null
       and blocked.start_at<booking.table_released_at
       and coalesce(blocked.end_at,'infinity'::timestamptz)>booking.starts_at
    )
  order by case small.code when 'A2' then 0 when 'A1' then 1 else 2 end
  limit 1;

  if not found then continue;end if;

  update public.reservation_tables assigned
  set table_id=destination.id
  from public.reservations current_booking
  where assigned.reservation_id=booking.id and assigned.table_id=booking.table_id
    and current_booking.id=assigned.reservation_id and current_booking.status='confirmed'
    and current_booking.starts_at>clock_timestamp();

  if found then
   insert into public.reservation_table_move_log(reservation_id,from_table,to_table,reason)
   values (booking.id,booking.code,destination.code,
           case when p_released_start is null then 'inventory_review' else 'cancellation' end);

   reservation_starts_at:=booking.starts_at;
   from_table:=booking.code;
   to_table:=destination.code;
   return next;
  end if;
 end loop;
end $$;
revoke all on function public.rebalance_small_parties(timestamptz,timestamptz) from public,anon,authenticated;

create function public.rebalance_after_reservation_cancellation()
returns trigger language plpgsql set search_path='' as $$
begin
 if old.table_released_at>clock_timestamp() and exists (
  select 1 from public.reservation_tables rt
  join public.restaurant_tables t on t.id=rt.table_id
  where rt.reservation_id=new.id and t.code in ('A1','A2','A3')
 ) then
  perform public.rebalance_small_parties(old.starts_at,old.table_released_at);
 end if;
 return new;
end $$;
revoke all on function public.rebalance_after_reservation_cancellation() from public,anon,authenticated;

create trigger rebalance_after_reservation_cancellation
after update of status on public.reservations
for each row
when (old.status in ('confirmed','seated') and new.status='cancelled')
execute function public.rebalance_after_reservation_cancellation();
