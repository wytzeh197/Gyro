-- Hidden prototype. Intentionally independent of the existing Cloud billing
-- schema. No hosted project is targeted by this migration file.
create schema cloud_agents;
revoke all on schema cloud_agents from public, anon;
grant usage on schema cloud_agents to authenticated, service_role;

create table cloud_agents.users (
  id uuid primary key references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create table cloud_agents.hour_balance (
  user_id uuid primary key references cloud_agents.users(id),
  seconds bigint not null default 0 check (seconds >= 0),
  reserved_seconds bigint not null default 0 check (reserved_seconds >= 0 and reserved_seconds <= seconds),
  hour_balance numeric generated always as ((seconds - reserved_seconds)::numeric / 3600) stored
);
create table cloud_agents.cloud_runs (
  id uuid primary key,
  user_id uuid not null references cloud_agents.users(id),
  status text not null check (status in ('queued','running','waiting','blocked','done','failed','cancelled')),
  reason text,
  repo text not null,
  branch text not null,
  result_branch text not null check (result_branch = 'gyro/cloud/' || id::text),
  task text not null,
  provider text not null check (provider in ('claude','codex')),
  model text,
  cap_seconds integer not null check (cap_seconds between 60 and 3600),
  idle_seconds integer not null default 600 check (idle_seconds between 60 and 600),
  used_seconds integer not null default 0 check (used_seconds >= 0 and used_seconds <= cap_seconds),
  reserved_seconds integer not null default 0 check (reserved_seconds >= 0),
  segment integer not null default 1,
  activated_at timestamptz,
  deadline_at timestamptz,
  request jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index cloud_runs_owner on cloud_agents.cloud_runs(user_id, created_at desc);
create table cloud_agents.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references cloud_agents.users(id),
  run_id uuid,
  segment integer,
  kind text not null check (kind in ('reserve','charge','release','topup')),
  seconds integer not null check (seconds >= 0),
  created_at timestamptz not null default now(),
  foreign key (run_id, user_id) references cloud_agents.cloud_runs(id, user_id),
  unique (run_id, segment, kind)
);
create index usage_ledger_owner on cloud_agents.usage_ledger(user_id, created_at desc);
create table cloud_agents.control (
  id boolean primary key default true check (id),
  enabled boolean not null default false
);
insert into cloud_agents.control(id, enabled) values (true, false);

alter table cloud_agents.users enable row level security;
alter table cloud_agents.users force row level security;
alter table cloud_agents.hour_balance enable row level security;
alter table cloud_agents.hour_balance force row level security;
alter table cloud_agents.cloud_runs enable row level security;
alter table cloud_agents.cloud_runs force row level security;
alter table cloud_agents.usage_ledger enable row level security;
alter table cloud_agents.usage_ledger force row level security;
alter table cloud_agents.control enable row level security;
alter table cloud_agents.control force row level security;
create policy own_user on cloud_agents.users for select to authenticated using ((select auth.uid()) = id);
create policy own_balance on cloud_agents.hour_balance for select to authenticated using ((select auth.uid()) = user_id);
create policy own_run on cloud_agents.cloud_runs for select to authenticated using ((select auth.uid()) = user_id);
create policy own_ledger on cloud_agents.usage_ledger for select to authenticated using ((select auth.uid()) = user_id);
-- No client policy on control. No client can insert/update/delete any table.
grant select on cloud_agents.users, cloud_agents.hour_balance, cloud_agents.cloud_runs, cloud_agents.usage_ledger to authenticated;
grant select, insert, update on all tables in schema cloud_agents to service_role;
revoke update on cloud_agents.usage_ledger from service_role;

create function cloud_agents.immutable_ledger() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin raise exception 'usage ledger is append only'; end;
$$;
create trigger immutable_ledger before update or delete on cloud_agents.usage_ledger
for each row execute function cloud_agents.immutable_ledger();
revoke all on function cloud_agents.immutable_ledger() from public, anon, authenticated;

-- Only the Worker service credential may execute this RPC. It is deliberately
-- SECURITY INVOKER. Clients can neither impersonate p_user_id nor credit hours.
create function public.cloud_agents_rpc(p_action text, p_user_id uuid, p_run_id uuid default null, p_data jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r cloud_agents.cloud_runs%rowtype;
  b cloud_agents.hour_balance%rowtype;
  enabled boolean;
  amount integer;
  charged integer;
  ended timestamptz;
begin
  select c.enabled into enabled from cloud_agents.control c where c.id;
  if p_action = 'stale' then
    return coalesce((select jsonb_agg(to_jsonb(s) - 'request') from
      (select * from cloud_agents.cloud_runs where
        (status = 'queued' and updated_at < now() - interval '2 minutes') or
        (status = 'running' and deadline_at < now() - interval '1 minute')
       order by updated_at limit 100) s), '[]'::jsonb);
  end if;
  if p_user_id is null then return jsonb_build_object('error','invalid_request'); end if;
  if p_action = 'control' then return jsonb_build_object('enabled',coalesce(enabled,false)); end if;
  insert into cloud_agents.users(id) values (p_user_id) on conflict do nothing;
  insert into cloud_agents.hour_balance(user_id) values (p_user_id) on conflict do nothing;
  if p_action = 'balance' then
    select * into b from cloud_agents.hour_balance where user_id = p_user_id;
    return to_jsonb(b);
  elsif p_action = 'list' then
    return coalesce((select jsonb_agg(to_jsonb(s) - 'request') from
      (select * from cloud_agents.cloud_runs where user_id = p_user_id order by created_at desc limit 100) s), '[]'::jsonb);
  elsif p_action = 'get' then
    select * into r from cloud_agents.cloud_runs where id = p_run_id and user_id = p_user_id;
    if not found then return jsonb_build_object('error','not_found'); end if;
    return to_jsonb(r) - 'request';
  end if;
  -- All mutations lock balance first, then run, including settlement. This
  -- serializes concurrent starts and avoids opposite-order deadlocks.
  select * into b from cloud_agents.hour_balance where user_id = p_user_id for update;
  if p_action = 'topup' then
    amount := (p_data->>'seconds')::integer;
    if amount is null or amount <= 0 or p_data->>'reference' is null then return jsonb_build_object('error','invalid_request'); end if;
    insert into cloud_agents.usage_ledger(id,user_id,kind,seconds)
      values ((p_data->>'reference')::uuid,p_user_id,'topup',amount) on conflict (id) do nothing;
    if found then update cloud_agents.hour_balance set seconds = seconds + amount where user_id = p_user_id; end if;
    return (select to_jsonb(h) from cloud_agents.hour_balance h where user_id = p_user_id);
  end if;
  select * into r from cloud_agents.cloud_runs where id = p_run_id and user_id = p_user_id for update;
  if p_action = 'reserve' then
    if found then
      if r.request <> p_data then return jsonb_build_object('error','conflict'); end if;
      return to_jsonb(r) - 'request';
    end if;
    if not coalesce(enabled,false) then return jsonb_build_object('error','disabled'); end if;
    amount := (p_data->>'cap_seconds')::integer;
    if amount is null or amount not between 60 and 3600 then return jsonb_build_object('error','invalid_request'); end if;
    if b.seconds - b.reserved_seconds < amount then return jsonb_build_object('error','insufficient_hours'); end if;
    if exists (select 1 from cloud_agents.cloud_runs where id = p_run_id) then return jsonb_build_object('error','conflict'); end if;
    insert into cloud_agents.cloud_runs(id,user_id,status,repo,branch,result_branch,task,provider,model,cap_seconds,idle_seconds,reserved_seconds,request)
      values(p_run_id,p_user_id,'queued',p_data->>'repo',p_data->>'branch',p_data->>'result_branch',p_data->>'task',p_data->>'provider',p_data->>'model',amount,(p_data->>'idle_seconds')::integer,amount,p_data)
      returning * into r;
    update cloud_agents.hour_balance set reserved_seconds = reserved_seconds + amount where user_id = p_user_id;
    insert into cloud_agents.usage_ledger(user_id,run_id,segment,kind,seconds) values(p_user_id,r.id,r.segment,'reserve',amount);
  elsif r.id is null then return jsonb_build_object('error','not_found');
  elsif p_action = 'activate' then
    if r.status = 'running' then return to_jsonb(r) - 'request'; end if;
    if r.status <> 'queued' or not coalesce(enabled,false) then return jsonb_build_object('error','invalid_state'); end if;
    update cloud_agents.cloud_runs set status='running', activated_at=now(), deadline_at=now()+reserved_seconds * interval '1 second', updated_at=now()
      where id=r.id returning * into r;
  elsif p_action = 'resume' then
    if r.status in ('queued','running') then return to_jsonb(r) - 'request'; end if;
    if r.status <> 'waiting' or not coalesce(enabled,false) then return jsonb_build_object('error','invalid_state'); end if;
    amount := r.cap_seconds - r.used_seconds;
    if amount <= 0 then return jsonb_build_object('error','cap_reached'); end if;
    if b.seconds - b.reserved_seconds < amount then return jsonb_build_object('error','insufficient_hours'); end if;
    update cloud_agents.hour_balance set reserved_seconds=reserved_seconds+amount where user_id=p_user_id;
    update cloud_agents.cloud_runs set status='queued',reason=null,segment=segment+1,reserved_seconds=amount,activated_at=null,deadline_at=null,updated_at=now() where id=r.id returning * into r;
    insert into cloud_agents.usage_ledger(user_id,run_id,segment,kind,seconds) values(p_user_id,r.id,r.segment,'reserve',amount);
  elsif p_action = 'settle' then
    if (p_data->>'segment')::integer <> r.segment then return jsonb_build_object('error','conflict'); end if;
    if r.reserved_seconds = 0 then
      -- A paused run can later be cancelled without another charge.
      if r.status = 'waiting' and p_data->>'status' = 'cancelled' then
        update cloud_agents.cloud_runs set status='cancelled',reason='user_stop',updated_at=now() where id=r.id returning * into r;
      end if;
      return to_jsonb(r) - 'request';
    end if;
    if p_data->>'status' not in ('done','failed','cancelled','waiting','blocked') then return jsonb_build_object('error','invalid_state'); end if;
    ended := least(coalesce((p_data->>'ended_at')::timestamptz,now()),now());
    charged := case when r.activated_at is null then 0 else least(r.reserved_seconds,greatest(0,ceil(extract(epoch from ended-r.activated_at))::integer)) end;
    update cloud_agents.hour_balance set seconds=seconds-charged,reserved_seconds=reserved_seconds-r.reserved_seconds where user_id=p_user_id;
    insert into cloud_agents.usage_ledger(user_id,run_id,segment,kind,seconds) values
      (p_user_id,r.id,r.segment,'charge',charged),
      (p_user_id,r.id,r.segment,'release',r.reserved_seconds-charged);
    update cloud_agents.cloud_runs set status=p_data->>'status',reason=p_data->>'reason',used_seconds=used_seconds+charged,reserved_seconds=0,updated_at=now() where id=r.id returning * into r;
  else return jsonb_build_object('error','invalid_action');
  end if;
  return to_jsonb(r) - 'request';
end;
$$;
revoke all on function public.cloud_agents_rpc(text,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.cloud_agents_rpc(text,uuid,uuid,jsonb) to service_role;
