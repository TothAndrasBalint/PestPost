// /api/cron-runner.js  (v1 — peek or claim due items)
import { supabaseAdmin } from '../lib/supabase.js';

const CRON_TOKEN = process.env.CRON_TOKEN || process.env.ADMIN_API_TOKEN;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export async function GET(request) {
  const url = new URL(request.url);

  // --- token guard (Authorization: Bearer <token> OR ?token=...) ---
  const hdr = request.headers.get('authorization') || '';
  const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7) : null;
  const provided = bearer || url.searchParams.get('token') || '';
  if (!CRON_TOKEN || provided !== CRON_TOKEN) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const action = (url.searchParams.get('action') || 'peek').toLowerCase();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10), 1), 500);
  const nowIso = new Date().toISOString();

  const baseSelect = supabaseAdmin
    .from('draft_posts')
    .select('id, from_wa, source_message_id, status, approved_at, scheduled_at, queued_at')
    .eq('status', 'approved')
    .not('scheduled_at', 'is', null)
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true });

  if (action === 'peek') {
    const { data, error } = await baseSelect
      .is('queued_at', null)
      .range(0, limit - 1);
    if (error) return json({ ok: false, error: error.message }, 500);
    console.log(`[cron-runner] peek due=${data?.length || 0} at ${nowIso}`);
    return json({ ok: true, mode: 'peek', now: nowIso, count: data?.length || 0, items: data || [] });
  }

  if (action === 'claim') {
    // Step 1: pick up to N due, unqueued items
    const { data: due, error: selErr } = await baseSelect
      .is('queued_at', null)
      .range(0, limit - 1)
      .select('id'); // narrow select for the first step
    if (selErr) return json({ ok: false, error: selErr.message }, 500);
    const ids = (due || []).map(r => r.id);
    if (!ids.length) return json({ ok: true, mode: 'claim', now: nowIso, claimed: 0, items: [] });

    // Step 2: atomically mark them queued (idempotent guard queued_at IS NULL)
    const { data: claimed, error: updErr } = await supabaseAdmin
      .from('draft_posts')
      .update({ queued_at: nowIso })
      .in('id', ids)
      .is('queued_at', null)
      .select('id, from_wa, source_message_id, status, approved_at, scheduled_at, queued_at')
      .order('scheduled_at', { ascending: true });
    if (updErr) return json({ ok: false, error: updErr.message }, 500);

    console.log(`[cron-runner] claimed=${claimed?.length || 0} at ${nowIso}`);
    return json({ ok: true, mode: 'claim', now: nowIso, claimed: claimed?.length || 0, items: claimed || [] });
  }

  return json({ ok: false, error: 'bad_action', hint: "Use action=peek or action=claim" }, 400);
}
