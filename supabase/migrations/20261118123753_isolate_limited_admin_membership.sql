set local lock_timeout = '3s';

-- Older server deployments treat everyone in admin_users as a full administrator.
-- Keep that table exclusively for owners and resolve limited accounts separately.
alter table public.admin_users
 alter column role set default 'owner',
 add constraint admin_users_owner_only check (role='owner');

create table public.admin_staff_users (
 user_id uuid primary key references auth.users(id) on delete cascade,
 created_at timestamptz not null default now()
);
alter table public.admin_staff_users enable row level security;
revoke all on public.admin_staff_users from public,anon,authenticated,service_role;
grant select on public.admin_staff_users to service_role;
