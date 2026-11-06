-- Staff invites. The owner adds a number; the person accepts the next time they message the bot
-- (an invite template can message them first once Meta approves templates).
-- The invitee has no shop yet, so these two functions work by phone and are callable by the engine only.

create or replace function app.pending_invites(p_phone text)
returns table (membership_id uuid, tenant_id uuid, tenant_name text, invited_by_name text, user_name text)
language sql stable security definer
set search_path = public, app, pg_temp
as $$
  select m.id, t.id, t.name, ib.name, u.name
    from public.users u
    join public.memberships m on m.user_id = u.id and m.status = 'invited'
    join public.tenants t on t.id = m.tenant_id and t.status = 'active'
    left join public.users ib on ib.id = m.invited_by
   where u.phone = p_phone
   order by m.created_at desc
$$;

-- Accept or decline one invite of this phone. Returns the shop id, or null if there was no such invite.
create or replace function app.respond_invite(p_phone text, p_membership_id uuid, p_accept boolean)
returns uuid
language plpgsql volatile security definer
set search_path = public, app, pg_temp
as $$
declare v_tenant uuid; v_user uuid;
begin
  update public.memberships m
     set status = case when p_accept then 'active' else 'removed' end,
         removed_at = case when p_accept then null else now() end
    from public.users u
   where m.id = p_membership_id and m.user_id = u.id and u.phone = p_phone and m.status = 'invited'
  returning m.tenant_id, m.user_id into v_tenant, v_user;
  if v_tenant is not null then
    insert into public.audit_log (tenant_id, actor_kind, actor_user_id, action, entity_type, entity_id)
    values (v_tenant, 'user', v_user, case when p_accept then 'staff.accept' else 'staff.decline' end, 'membership', p_membership_id);
  end if;
  return v_tenant;
end $$;

revoke all on function app.pending_invites(text), app.respond_invite(text, uuid, boolean) from public;
grant execute on function app.pending_invites(text), app.respond_invite(text, uuid, boolean) to app_engine;
