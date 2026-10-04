-- Queue+ Supabase schema
--
-- This is a snapshot of the live schema on the Supabase project referenced by
-- supabase-config.js. It is tracked here so backend changes (tables, RLS
-- policies, SQL functions, triggers, cron jobs) are visible in GitHub instead
-- of only existing inside the Supabase dashboard. Applied with
-- apply_migration against the live project; this file is then updated to
-- match so it stays a faithful mirror, not a source the app reads from.
--
-- Everything mutates through SECURITY DEFINER functions below, which is why
-- the client only ever needs the public anon/publishable key (see the
-- comment in supabase-config.js) — row level security blocks direct table
-- writes, and the functions encode who's allowed to do what.

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists pg_cron;

-- ============================================================
-- Tables
-- ============================================================

-- One row per staff/admin account, created automatically by the
-- on_auth_user_created trigger when someone signs up via Supabase Auth.
create table public.staff (
  id uuid primary key references auth.users(id),
  full_name text not null default '',
  role text not null default 'staff' check (role in ('staff', 'admin')),
  created_at timestamptz not null default now()
);
alter table public.staff enable row level security;
-- Staff can see their own profile (role, name) to drive the UI; they cannot
-- list other staff. Writes only happen via the handle_new_user trigger.
create policy "own row" on public.staff
  for select using (auth.uid() = id);

-- One row per physical/virtual counter.
create table public.counters (
  id text primary key,
  status text not null default 'Idle',
  ticket text not null default '',
  service text not null default '',
  transaction_type text not null default '',
  priority boolean not null default false,
  priority_reason text not null default '',
  ticket_id uuid,
  recall_count integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.counters enable row level security;
-- Readable by anyone (display board, staff panel) — writes only via
-- SECURITY DEFINER functions (add_counter, delete_counter, call_next,
-- mark_done, recall_previous, transfer_client, reset_queue, auto_reset_queue).
create policy "public read" on public.counters
  for select using (true);

-- One row per ticket ever issued.
create table public.queue (
  id uuid primary key default gen_random_uuid(),
  ticket text not null,
  service text not null,
  transaction_type text not null default '',
  priority boolean not null default false,
  priority_reason text not null default '',
  status text not null default 'Waiting',
  counter text not null default '',
  cycle text not null,
  transferred boolean not null default false,
  transferred_from text not null default '',
  queue_rank integer not null default 2,
  created_at timestamptz not null default now(),
  called_at timestamptz,
  done_at timestamptz
);
alter table public.queue enable row level security;
-- Readable by anyone (display board, reports) — writes only via
-- SECURITY DEFINER functions (generate_ticket, call_next, mark_done,
-- transfer_client, recall_previous).
create policy "public read" on public.queue
  for select using (true);

-- Per-cycle ticket number sequence, keyed like "<code>_<cycle>", e.g.
-- "C_2026-10-04_1" for Certification, "P_2026-10-04_1" for the shared
-- priority sequence, "T_2026-10-04_1" for the shared transfer sequence.
create table public.service_counters (
  id text primary key,
  last_number integer not null default 0
);
alter table public.service_counters enable row level security;
-- Intentionally no policies: not exposed to the REST API at all, only
-- read/written from inside generate_ticket/transfer_client via
-- SECURITY DEFINER (which bypasses RLS).

-- Single-row table tracking the active queue cycle (bumped by a reset).
create table public.system_state (
  id integer primary key default 1,
  active_cycle integer not null default 1,
  reset_by text not null default '',
  reset_at timestamptz
);
alter table public.system_state enable row level security;
create policy "public read" on public.system_state
  for select using (true);

-- Audit trail for admin actions (add/delete counter, manual/auto reset).
create table public.admin_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  actor text not null default '',
  details text not null default '',
  created_at timestamptz not null default now()
);
alter table public.admin_logs enable row level security;
create policy "public read" on public.admin_logs
  for select using (true);

-- ============================================================
-- Functions
-- ============================================================

create or replace function public.is_admin()
 returns boolean
 language sql
 stable security definer
as $function$
  select exists (select 1 from staff where id = auth.uid() and role = 'admin');
$function$;

create or replace function public.get_active_cycle()
 returns text
 language sql
 stable
as $function$
  select to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD') || '_' ||
         (select active_cycle from system_state where id = 1)::text;
$function$;

-- Creates a staff profile row the moment someone signs up via Supabase Auth.
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  insert into public.staff (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), 'staff')
  on conflict (id) do nothing;
  return new;
end;
$function$;

-- Generates a new ticket. Regular tickets use a per-service, per-cycle
-- sequence (C-001, A-001, ...). Priority tickets use one shared P-XXX
-- sequence across all services (same pattern as transfer_client's T-XXX),
-- so frontliners see at a glance which tickets are priority. The service
-- column — used for queue matching/ordering and already shown next to the
-- ticket number on every screen — still identifies the transaction type,
-- so a P-ticket still lines up in its own service's queue.
create or replace function public.generate_ticket(p_service text, p_priority boolean, p_priority_reason text)
 returns queue
 language plpgsql
 security definer
as $function$
declare
  v_code text;
  v_cycle text;
  v_counter_key text;
  v_next int;
  v_ticket_str text;
  v_row queue;
begin
  v_code := case p_service
    when 'Certification' then 'C'
    when 'Authentication' then 'A'
    when 'Exam Application' then 'EA'
    when 'Renewal' then 'R'
    when 'Initial Registration' then 'IR'
    when 'Duplicate ID' then 'D'
    when 'Certificate of Registration' then 'COR'
    when 'Stateboard Verification' then 'SV'
    when 'Real Estate Salesperson' then 'RES'
    when 'Medical Representative' then 'MED'
    when 'Accreditation' then 'RDA'
    else null
  end;
  if v_code is null then raise exception 'Invalid service.'; end if;

  v_cycle := get_active_cycle();

  if p_priority then
    v_counter_key := 'P_' || v_cycle;
  else
    v_counter_key := v_code || '_' || v_cycle;
  end if;

  insert into service_counters (id, last_number) values (v_counter_key, 1)
    on conflict (id) do update set last_number = service_counters.last_number + 1
    returning last_number into v_next;

  v_ticket_str := (case when p_priority then 'P-' else v_code || '-' end) || lpad(v_next::text, 3, '0');

  insert into queue (ticket, service, priority, priority_reason, status, cycle, queue_rank)
  values (v_ticket_str, p_service, coalesce(p_priority,false), case when p_priority then coalesce(p_priority_reason,'') else '' end,
          'Waiting', v_cycle, case when p_priority then 0 else 2 end)
  returning * into v_row;

  return v_row;
end;
$function$;

-- Pulls the next waiting ticket (priority first, then FIFO) into a counter.
create or replace function public.call_next(p_counter_id text, p_service text default null::text)
 returns queue
 language plpgsql
 security definer
as $function$
declare
  v_cycle text;
  v_row queue;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  v_cycle := get_active_cycle();

  select * into v_row
  from queue
  where status = 'Waiting' and cycle = v_cycle
    and (p_service is null or service = p_service)
  order by queue_rank asc, created_at asc
  limit 1
  for update skip locked;

  if v_row.id is null then
    raise exception '%', case when p_service is not null then 'No clients waiting for ' || p_service || '.' else 'No clients waiting.' end;
  end if;

  update queue set status = 'Now Serving', counter = p_counter_id, called_at = now()
    where id = v_row.id returning * into v_row;

  update counters set
    status = 'Now Serving', ticket = v_row.ticket, service = v_row.service,
    transaction_type = v_row.transaction_type, priority = v_row.priority,
    priority_reason = v_row.priority_reason, ticket_id = v_row.id,
    recall_count = 0, updated_at = now()
  where id = p_counter_id;

  return v_row;
end;
$function$;

create or replace function public.mark_done(p_counter_id text)
 returns text
 language plpgsql
 security definer
as $function$
declare
  v_counter counters;
  v_message text := 'No ticket marked as done.';
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_counter from counters where id = p_counter_id;
  if v_counter.id is null then raise exception 'Counter not found.'; end if;

  if v_counter.ticket_id is not null then
    update queue set status = 'Done', done_at = now() where id = v_counter.ticket_id;
    v_message := v_counter.ticket || ' marked as done.';
  end if;

  update counters set status='Idle', ticket='', service='', transaction_type='',
    priority=false, priority_reason='', ticket_id=null, recall_count=0, updated_at=now()
  where id = p_counter_id;

  return v_message;
end;
$function$;

create or replace function public.recall_previous(p_counter_id text)
 returns queue
 language plpgsql
 security definer
as $function$
declare
  v_counter counters;
  v_row queue;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_counter from counters where id = p_counter_id;
  if v_counter.ticket_id is null then raise exception 'No previous transaction %', p_counter_id; end if;

  update queue set called_at = now() where id = v_counter.ticket_id returning * into v_row;
  update counters set recall_count = recall_count + 1, updated_at = now() where id = p_counter_id;

  return v_row;
end;
$function$;

-- Marks the counter's current ticket Done and issues a new T-XXX ticket
-- (shared sequence across services) for the service the client actually
-- needs, first in line for that service.
create or replace function public.transfer_client(p_counter_id text, p_target_service text)
 returns queue
 language plpgsql
 security definer
as $function$
declare
  v_counter counters;
  v_cycle text;
  v_counter_key text;
  v_next int;
  v_ticket_str text;
  v_row queue;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_counter from counters where id = p_counter_id;
  if v_counter.ticket_id is null then raise exception 'No active ticket to transfer.'; end if;

  update queue set status = 'Done', done_at = now() where id = v_counter.ticket_id;

  v_cycle := get_active_cycle();
  v_counter_key := 'T_' || v_cycle;
  insert into service_counters (id, last_number) values (v_counter_key, 1)
    on conflict (id) do update set last_number = service_counters.last_number + 1
    returning last_number into v_next;
  v_ticket_str := 'T-' || lpad(v_next::text, 3, '0');

  insert into queue (ticket, service, status, cycle, transferred, transferred_from, queue_rank)
  values (v_ticket_str, p_target_service, 'Waiting', v_cycle, true, p_counter_id, 1)
  returning * into v_row;

  update counters set status='Idle', ticket='', service='', transaction_type='',
    priority=false, priority_reason='', ticket_id=null, recall_count=0, updated_at=now()
  where id = p_counter_id;

  return v_row;
end;
$function$;

create or replace function public.add_counter(p_counter_id text, p_actor text)
 returns void
 language plpgsql
 security definer
as $function$
begin
  if not is_admin() then raise exception 'Admin only.'; end if;
  if exists (select 1 from counters where id = p_counter_id) then
    raise exception 'Counter already exists.';
  end if;
  insert into counters (id) values (p_counter_id);
  insert into admin_logs (action, actor, details) values ('Add Counter', p_actor, p_counter_id);
end;
$function$;

create or replace function public.delete_counter(p_counter_id text, p_actor text)
 returns void
 language plpgsql
 security definer
as $function$
declare
  v_status text;
begin
  if not is_admin() then raise exception 'Admin only.'; end if;
  select status into v_status from counters where id = p_counter_id;
  if v_status is null then raise exception 'Counter does not exist.'; end if;
  if v_status = 'Now Serving' then raise exception 'Cannot delete a counter that is currently serving a client.'; end if;
  delete from counters where id = p_counter_id;
  insert into admin_logs (action, actor, details) values ('Delete Counter', p_actor, p_counter_id);
end;
$function$;

create or replace function public.reset_queue(p_actor text)
 returns void
 language plpgsql
 security definer
as $function$
begin
  if not is_admin() then raise exception 'Admin only.'; end if;

  update system_state set active_cycle = active_cycle + 1, reset_by = p_actor, reset_at = now() where id = 1;
  update counters set status='Idle', ticket='', service='', transaction_type='',
    priority=false, priority_reason='', ticket_id=null, recall_count=0, updated_at=now()
    where true;
  insert into admin_logs (action, actor, details) values ('Manual Reset', p_actor, '');
end;
$function$;

-- Same as reset_queue but run by the daily-midnight-manila-reset cron job
-- instead of an admin (see Scheduled jobs below).
create or replace function public.auto_reset_queue()
 returns void
 language plpgsql
 security definer
as $function$
begin
  update system_state set active_cycle = active_cycle + 1, reset_by = 'System (Auto Reset)', reset_at = now() where id = 1;
  update counters set status='Idle', ticket='', service='', transaction_type='',
    priority=false, priority_reason='', ticket_id=null, recall_count=0, updated_at=now()
    where true;
  insert into admin_logs (action, actor, details) values ('Auto Reset', 'System (Auto Reset)', 'Scheduled midnight (Asia/Manila) reset');
end;
$function$;

create or replace function public.get_completed_in_range(p_start_date date, p_end_date date)
 returns setof queue
 language sql
 stable
as $function$
  select * from queue
  where done_at >= (p_start_date::text || ' 00:00:00+08')::timestamptz
    and done_at <= (p_end_date::text || ' 23:59:59.999+08')::timestamptz
  order by done_at asc;
$function$;

-- ============================================================
-- Triggers
-- ============================================================

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- Scheduled jobs (pg_cron)
-- ============================================================

-- 16:00 UTC = midnight Asia/Manila.
select cron.schedule('daily-midnight-manila-reset', '0 16 * * *', 'select public.auto_reset_queue();');
