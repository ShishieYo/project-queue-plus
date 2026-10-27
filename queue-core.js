// queue-core.js (Supabase version)
// Same exported function names/shapes as the old Firebase version, so
// ticket-kiosk.html, staff-panel.html, and display-board.html need only
// their auth screens changed — everything else calls this the same way.

import { supabase } from "./supabase-config.js?v1";

function reportError(err) {
  console.error('[queue-core/supabase] error:', err);
  try {
    if (typeof window !== 'undefined' && typeof window.__queueCoreOnError === 'function') {
      window.__queueCoreOnError(err);
    }
  } catch (e) { /* never let the error handler itself throw */ }
}

export const SERVICES = [
  { code: 'C',   name: 'Certification' },
  { code: 'A',   name: 'Authentication' },
  { code: 'EA',  name: 'Exam Application' },
  { code: 'R',   name: 'Renewal' },
  { code: 'IR',  name: 'Initial Registration' },
  { code: 'D',   name: 'Duplicate ID' },
  { code: 'COR', name: 'Certificate of Registration' },
  { code: 'SV',  name: 'Stateboard Verification' },
  { code: 'RES', name: 'Real Estate Salesperson' },
  { code: 'MED', name: 'Medical Representative' },
  { code: 'RDA', name: 'Accreditation' }
];
export const PRIORITY_REASONS = ['Senior Citizen', 'PWD', 'Pregnant Woman', 'Solo Parent', 'Other'];

// ================= Manila-timezone date helpers (display/lookup only —
// the actual "which day is this" decision for cycles/reports happens in
// Postgres now via get_active_cycle() / get_completed_in_range()). =================
export function getManilaDateString(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date || new Date());
}
export function getManilaYesterdayString() {
  return getManilaDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
}
async function getActiveCycleClient() {
  const { data, error } = await supabase.rpc('get_active_cycle');
  if (error) throw new Error(error.message);
  return data;
}

// ================= Auth =================
// Supabase Auth needs an email under the hood, so staff sign in with a short
// User ID (e.g. "counter3") which gets mapped to counter3@STAFF_AUTH_DOMAIN.
// Shared by staff-panel.html and the kiosk's staff-override login.
export const STAFF_AUTH_DOMAIN = 'queueplus.internal';
export function resolveStaffLoginEmail(input) {
  const s = (input || '').trim();
  return s.includes('@') ? s : `${s.toLowerCase()}@${STAFF_AUTH_DOMAIN}`;
}
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data.user;
}
export async function signOut() {
  await supabase.auth.signOut();
}
export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data.user || null;
}
// Returns { role: 'staff'|'admin', fullName } for the logged-in user, or null if not logged in.
export async function getMyProfile() {
  const user = await getCurrentUser();
  if (!user) return null;
  const { data, error } = await supabase.from('staff').select('role, full_name').eq('id', user.id).single();
  if (error) return { role: 'staff', fullName: '' };
  return { role: data.role, fullName: data.full_name || '' };
}

// ================= Row mappers (snake_case DB -> camelCase app shape) =================
function mapCounterRow(row) {
  return {
    counterId: row.id, status: row.status, ticket: row.ticket, service: row.service,
    transactionType: row.transaction_type || '', priority: !!row.priority, priorityReason: row.priority_reason || '',
    ticketId: row.ticket_id, recallCount: row.recall_count || 0, updatedAt: row.updated_at
  };
}

// ================= Generate a ticket (kiosk) =================
export async function addQueueTicket(serviceName, isPriority, priorityReason) {
  const { data, error } = await supabase.rpc('generate_ticket', {
    p_service: serviceName, p_priority: !!isPriority, p_priority_reason: isPriority ? (priorityReason || '') : ''
  });
  if (error) throw new Error(error.message);
  return { ticket: data.ticket, service: data.service, priority: !!data.priority, priorityReason: data.priority_reason || '' };
}

// ================= Call next / recall / mark done / transfer (staff) =================
export async function callNext(counterId, serviceFilter) {
  const { data, error } = await supabase.rpc('call_next', { p_counter_id: counterId, p_service: serviceFilter || null });
  if (error) throw new Error(error.message);
  return {
    ticket: data.ticket, service: data.service, transactionType: data.transaction_type || '',
    priority: !!data.priority, priorityReason: data.priority_reason || '', transferred: !!data.transferred, counter: counterId
  };
}
export async function recallPrevious(counterId) {
  const { data, error } = await supabase.rpc('recall_previous', { p_counter_id: counterId });
  if (error) throw new Error(error.message);
  return { ticket: data.ticket, service: data.service, transactionType: data.transaction_type || '', counter: counterId };
}
export async function markDone(counterId) {
  const { data, error } = await supabase.rpc('mark_done', { p_counter_id: counterId });
  if (error) throw new Error(error.message);
  return { message: data };
}
export async function transferClient(counterId, targetService) {
  const { data, error } = await supabase.rpc('transfer_client', { p_counter_id: counterId, p_target_service: targetService });
  if (error) throw new Error(error.message);
  return { newTicket: data.ticket, targetService: data.service, fromCounter: counterId };
}

// ================= Admin actions — server-side role check, no PIN needed anymore =================
export async function resetQueueSystem(actor) {
  const { error } = await supabase.rpc('reset_queue', { p_actor: actor || 'Unknown' });
  if (error) throw new Error(error.message);
}
export async function addCounter(counterId, actor) {
  const { error } = await supabase.rpc('add_counter', { p_counter_id: counterId, p_actor: actor || 'Unknown' });
  if (error) throw new Error(error.message);
}
export async function deleteCounter(counterId, actor) {
  const { error } = await supabase.rpc('delete_counter', { p_counter_id: counterId, p_actor: actor || 'Unknown' });
  if (error) throw new Error(error.message);
}

// Self-heal: idle out any counter still "Now Serving" a ticket from a
// previous cycle (e.g. nobody touched the panel overnight).
export async function cleanupStaleCounters() {
  try {
    const cycle = await getActiveCycleClient();
    const { data: busy } = await supabase.from('counters').select('*').eq('status', 'Now Serving');
    for (const c of (busy || [])) {
      if (!c.ticket_id) continue;
      const { data: t } = await supabase.from('queue').select('cycle').eq('id', c.ticket_id).maybeSingle();
      if (t && t.cycle !== cycle) {
        await markDone(c.id).catch(() => {});
      }
    }
  } catch (e) { /* best-effort */ }
}

// ================= Live listeners (Supabase Realtime) =================
// These used to refetch the full derived view from the REST API on every
// single row change — and every open tab (each staff counter, the display
// board) did that independently. With several tabs open all day and a busy
// queue, that fanned out into tens of thousands of small requests per day,
// which is what was filling the Supabase project's log-ingestion quota.
// Instead, each listener now keeps its own local copy of just the rows it
// cares about and patches it from the realtime payload (which always
// carries the complete new row), so steady-state updates cost zero extra
// REST calls.

// get_active_cycle() rarely changes (once a day, at a reset) but was being
// called on every single queue-table event. Cache the active_cycle number
// in memory and only refresh it by listening for the one-row system_state
// update a reset actually makes — the date portion is recomputed locally
// each time, so a plain midnight rollover (no reset) still stays correct.
let cachedActiveCycleNum = null;
let cycleChannel = null;
const cycleChangeListeners = new Set();
async function ensureCycleCache() {
  if (cachedActiveCycleNum === null) {
    const { data, error } = await supabase.from('system_state').select('active_cycle').eq('id', 1).single();
    if (error) throw new Error(error.message);
    cachedActiveCycleNum = data.active_cycle;
  }
  if (!cycleChannel) {
    cycleChannel = supabase.channel('system-state-watch')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'system_state' }, payload => {
        if (payload.new && payload.new.active_cycle !== cachedActiveCycleNum) {
          cachedActiveCycleNum = payload.new.active_cycle;
          cycleChangeListeners.forEach(fn => { try { fn(); } catch (e) { /* listener's own problem */ } });
        }
      })
      .subscribe(status => { if (status === 'CHANNEL_ERROR') reportError(new Error('Realtime channel error (system_state)')); });
  }
}
function currentCycleString() { return getManilaDateString() + '_' + cachedActiveCycleNum; }
function onCycleChange(fn) { cycleChangeListeners.add(fn); return () => cycleChangeListeners.delete(fn); }

export function listenCounters(cb) {
  let rows = new Map(); // id -> raw row
  const emit = () => cb(Array.from(rows.values()).sort((a, b) => a.id.localeCompare(b.id)).map(mapCounterRow));
  const fetchInitial = async () => {
    const { data, error } = await supabase.from('counters').select('*').order('id');
    if (error) { reportError(error); return; }
    rows = new Map((data || []).map(r => [r.id, r]));
    emit();
  };
  fetchInitial();
  const channel = supabase.channel('counters-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'counters' }, payload => {
      if (payload.eventType === 'DELETE') rows.delete(payload.old.id);
      else rows.set(payload.new.id, payload.new);
      emit();
    })
    .subscribe(status => { if (status === 'CHANNEL_ERROR') reportError(new Error('Realtime channel error (counters)')); });
  return () => supabase.removeChannel(channel);
}

export function listenCounter(counterId, cb) {
  const fetchInitial = async () => {
    const { data, error } = await supabase.from('counters').select('*').eq('id', counterId).maybeSingle();
    if (error) { reportError(error); return; }
    cb(data ? mapCounterRow(data) : null);
  };
  fetchInitial();
  const channel = supabase.channel('counter-' + counterId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'counters', filter: `id=eq.${counterId}` }, payload => {
      cb(payload.eventType === 'DELETE' ? null : mapCounterRow(payload.new));
    })
    .subscribe(status => { if (status === 'CHANNEL_ERROR') reportError(new Error('Realtime channel error (counter)')); });
  return () => supabase.removeChannel(channel);
}

export async function listenWaitingSummary(cb) {
  await ensureCycleCache();
  let waiting = new Map(); // queue row id -> service
  const emit = () => {
    const counts = {};
    SERVICES.forEach(s => counts[s.name] = 0);
    for (const svc of waiting.values()) counts[svc] = (counts[svc] || 0) + 1;
    cb(counts);
  };
  const fetchInitial = async () => {
    const { data, error } = await supabase.from('queue').select('id, service').eq('status', 'Waiting').eq('cycle', currentCycleString());
    if (error) { reportError(error); return; }
    waiting = new Map((data || []).map(r => [r.id, r.service]));
    emit();
  };
  await fetchInitial();
  const unsubCycle = onCycleChange(() => { waiting = new Map(); emit(); }); // a reset means zero waiting in the fresh cycle
  const channel = supabase.channel('waiting-summary')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, payload => {
      if (payload.eventType === 'DELETE') { waiting.delete(payload.old.id); emit(); return; }
      const row = payload.new;
      if (row.status === 'Waiting' && row.cycle === currentCycleString()) waiting.set(row.id, row.service);
      else waiting.delete(row.id);
      emit();
    })
    .subscribe(status => { if (status === 'CHANNEL_ERROR') reportError(new Error('Realtime channel error (waiting summary)')); });
  return () => { supabase.removeChannel(channel); unsubCycle(); };
}

export async function listenWaitingQueue(serviceFilter, cb) {
  await ensureCycleCache();
  let waiting = new Map(); // queue row id -> raw row
  const emit = () => {
    const arr = Array.from(waiting.values()).sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    cb(arr.map(r => ({
      ticket: r.ticket, service: r.service, transactionType: r.transaction_type || '',
      priority: !!r.priority, priorityReason: r.priority_reason || '', timestamp: r.created_at
    })));
  };
  const fetchInitial = async () => {
    let q = supabase.from('queue').select('*').eq('status', 'Waiting').eq('cycle', currentCycleString()).order('created_at', { ascending: true });
    if (serviceFilter) q = q.eq('service', serviceFilter);
    const { data, error } = await q;
    if (error) { reportError(error); return; }
    waiting = new Map((data || []).map(r => [r.id, r]));
    emit();
  };
  await fetchInitial();
  const unsubCycle = onCycleChange(() => { waiting = new Map(); emit(); });
  const channel = supabase.channel('waiting-queue-' + (serviceFilter || 'all'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, payload => {
      if (payload.eventType === 'DELETE') { waiting.delete(payload.old.id); emit(); return; }
      const row = payload.new;
      const matchesFilter = !serviceFilter || row.service === serviceFilter;
      if (row.status === 'Waiting' && row.cycle === currentCycleString() && matchesFilter) waiting.set(row.id, row);
      else waiting.delete(row.id);
      emit();
    })
    .subscribe(status => { if (status === 'CHANNEL_ERROR') reportError(new Error('Realtime channel error (waiting queue)')); });
  return () => { supabase.removeChannel(channel); unsubCycle(); };
}

// ================= Reports =================
export async function getCompletedTicketsInRange(startDateStr, endDateStr) {
  const { data, error } = await supabase.rpc('get_completed_in_range', { p_start_date: startDateStr, p_end_date: endDateStr });
  if (error) throw new Error(error.message);
  return (data || []).map(r => ({
    ticket: r.ticket || '', service: r.service || '', transactionType: r.transaction_type || '',
    counter: r.counter || '', transferred: !!r.transferred, priority: !!r.priority, priorityReason: r.priority_reason || '',
    createdAt: r.created_at ? new Date(r.created_at) : null,
    calledAt: r.called_at ? new Date(r.called_at) : null,
    doneAt: r.done_at ? new Date(r.done_at) : null
  }));
}

// Aggregated server-side (get_daily_stats) so only a few numbers cross the wire.
export async function getDailySummary(dateStr) {
  const d = dateStr || getManilaDateString();
  const { data, error } = await supabase.rpc('get_daily_stats', { p_date: d });
  if (error) throw new Error(error.message);
  return { date: d, total: data.total, perCounter: data.per_counter, avgWaitMin: data.avg_wait_min, avgProcMin: data.avg_proc_min };
}

// Live version — redraws shortly after a ticket is marked Done.
// get_daily_stats() aggregates (counts, averages) server-side in SQL, so
// unlike the listeners above this isn't safely diffable client-side without
// duplicating that math — instead, only refetch when a ticket actually
// completes (status/created/call changes don't affect these stats at all),
// and debounce bursts of completions into a single request.
export function listenDailySummary(dateStr, cb) {
  const d = dateStr || getManilaDateString();
  let debounceTimer = null;
  const fetchAndEmit = async () => {
    try { cb(await getDailySummary(d)); } catch (e) { reportError(e); }
  };
  fetchAndEmit();
  const channel = supabase.channel('daily-summary-' + d)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'queue' }, payload => {
      if (!payload.new || !payload.new.done_at) return; // only a completion affects today's stats
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fetchAndEmit, 1500);
    })
    .subscribe(status => { if (status === 'CHANNEL_ERROR') reportError(new Error('Realtime channel error (daily summary)')); });
  return () => { supabase.removeChannel(channel); clearTimeout(debounceTimer); };
}
