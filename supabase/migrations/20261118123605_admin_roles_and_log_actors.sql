set local lock_timeout = '3s';

-- Preserve permissions for existing employees and limit future grants by default.
alter table public.admin_users
 add column role text not null default 'owner' check (role in ('owner', 'staff'));
alter table public.admin_users alter column role set default 'staff';

-- Only the trusted server can resolve already-authorized log rows to a short name.
create function public.reservation_log_actor_names(p_ids uuid[])
returns table(log_id uuid, actor_name text)
language sql stable security definer set search_path=''
as $$
 select l.id, split_part(u.email, '@', 1)
 from public.admin_audit_logs l
 join auth.users u on u.id=l.actor_user_id
 where l.id=any(p_ids) and l.entity_type='reservation'
   and l.action in ('update','cancel') and l.created_at>=now()-interval '30 days'
   and u.email is not null;
$$;
revoke all on function public.reservation_log_actor_names(uuid[]) from public,anon,authenticated;
grant execute on function public.reservation_log_actor_names(uuid[]) to service_role;
