-- V1.8 retention: keep only the latest 30 days of reservation CHANGE logs.
-- Preserve non-reservation admin audit events, and preserve primary reservations.
create or replace function public.prune_reservation_change_logs()
returns void language plpgsql security definer set search_path=public as $$
begin
 delete from public.customer_booking_audit_logs where created_at < now()-interval '30 days';
 delete from public.admin_audit_logs
 where entity_type='reservation' and action in ('update','cancel') and created_at < now()-interval '30 days';
end $$;

create or replace function public.prune_reservation_change_logs_trigger()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform public.prune_reservation_change_logs();
 return null;
end $$;

drop trigger if exists customer_booking_log_retention on public.customer_booking_audit_logs;
create trigger customer_booking_log_retention
 after insert on public.customer_booking_audit_logs for each statement
 execute function public.prune_reservation_change_logs_trigger();
drop trigger if exists admin_booking_log_retention on public.admin_audit_logs;
create trigger admin_booking_log_retention
 after insert on public.admin_audit_logs for each statement
 execute function public.prune_reservation_change_logs_trigger();

revoke execute on function public.prune_reservation_change_logs() from public,anon,authenticated;
revoke execute on function public.prune_reservation_change_logs_trigger() from public,anon,authenticated;
grant execute on function public.prune_reservation_change_logs() to service_role;
