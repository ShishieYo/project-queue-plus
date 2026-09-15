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

// ================= Live listeners (Supabase Realtime: subscribe to raw row
// changes, refetch the derived view on every change) =================
export function listenCounters(cb) {
  const fetchAndEmit = async () => {
    const { data, error } = await supabase.from('counters').select('*').order('id');
    if (error) { reportError(error); return; }
    cb((data || []).map(mapCounterRow));
  };
  fetchAndEmit();
  const channel = supabase.channel('counters-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'counters' }, fetchAndEmit)
    .subscribe(status => { if (status === 'CHANNEL_ERROR') reportError(new Error('Realtime channel error (counters)')); });
  return () => supabase.removeChannel(channel);
}

export function listenCounter(counterId, cb) {
  const fetchAndEmit = async () => {
    const { data, error } = await supabase.from('counters').select('*').eq('id', counterId).maybeSingle();
    if (error) { reportError(error); return; }
    cb(data ? mapCounterRow(data) : null);
  };
  fetchAndEmit();
  const channel = supabase.channel('counter-' + counterId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'counters', filter: `id=eq.${counterId}` }, fetchAndEmit)
    .subscribe(status => { if (status === 'CHANNEL_ERROR') reportError(new Error('Realtime channel error (counter)')); });
  return () => supabase.removeChannel(channel);
}

export async function listenWaitingSummary(cb) {
  const fetchAndEmit = async () => {
    try {
      const cycle = await getActiveCycleClient();
      const { data, error } = await supabase.from('queue').select('service').eq('status', 'Waiting').eq('cycle', cycle);
      if (error) { reportError(error); return; }
      const counts = {};
      SERVICES.forEach(s => counts[s.name] = 0);
      (data || []).forEach(r => { counts[r.service] = (counts[r.service] || 0) + 1; });
      cb(counts);
    } catch (e) { reportError(e); }
  };
  await fetchAndEmit();
  const channel = supabase.channel('waiting-summary')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, fetchAndEmit)
    .subscribe(status => { if (status === 'CHANNEL_ERROR') reportError(new Error('Realtime channel error (waiting summary)')); });
  return () => supabase.removeChannel(channel);
}

export async function listenWaitingQueue(serviceFilter, cb) {
  const fetchAndEmit = async () => {
    try {
      const cycle = await getActiveCycleClient();
      let q = supabase.from('queue').select('*').eq('status', 'Waiting').eq('cycle', cycle).order('created_at', { ascending: true });
      if (serviceFilter) q = q.eq('service', serviceFilter);
      const { data, error } = await q;
      if (error) { reportError(error); return; }
      cb((data || []).map(r => ({
        ticket: r.ticket, service: r.service, transactionType: r.transaction_type || '',
        priority: !!r.priority, priorityReason: r.priority_reason || '', timestamp: r.created_at
      })));
    } catch (e) { reportError(e); }
  };
  await fetchAndEmit();
  const channel = supabase.channel('waiting-queue-' + (serviceFilter || 'all'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, fetchAndEmit)
    .subscribe(status => { if (status === 'CHANNEL_ERROR') reportError(new Error('Realtime channel error (waiting queue)')); });
  return () => supabase.removeChannel(channel);
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

export async function getDailySummary(dateStr) {
  const d = dateStr || getManilaDateString();
  const rows = await getCompletedTicketsInRange(d, d);
  const perCounter = {}, perService = {};
  rows.forEach(r => {
    perCounter[r.counter] = (perCounter[r.counter] || 0) + 1;
    perService[r.service] = (perService[r.service] || 0) + 1;
  });
  return { date: d, perCounter, perService };
}

// Live version — redraws the instant a ticket is marked Done, no polling.
export function listenDailySummary(dateStr, cb) {
  const d = dateStr || getManilaDateString();
  const fetchAndEmit = async () => {
    try { cb(await getDailySummary(d)); } catch (e) { reportError(e); }
  };
  fetchAndEmit();
  const channel = supabase.channel('daily-summary-' + d)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, fetchAndEmit)
    .subscribe(status => { if (status === 'CHANNEL_ERROR') reportError(new Error('Realtime channel error (daily summary)')); });
  return () => supabase.removeChannel(channel);
}
