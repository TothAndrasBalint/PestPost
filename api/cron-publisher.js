// /api/cron-publisher.js  (stub — no real posting yet)
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

  const action  = (url.searchParams.get('action') || 'peek').toLowerCase(); // peek | post
  const limit   = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10), 1), 200);
  const dryRun  = (url.searchParams.get('dry_run') || 'false').toLowerCase() === 'true';

  // Work queue: items that are claimed (queued_at not null) and not yet posted
  const base = supabaseAdmin
    .from('draft_posts')
    .select('id, from_wa, source_message_id, status, approved_at, scheduled_at, queued_at, posted_at, posted_result, posted_error')
    .not('queued_at', 'is', null)
    .is('posted_at', null)
    .order('queued_at', { ascending: true })
    .limit(limit);

  if (action === 'peek') {
    const { data, error } = await base;
    if (error) return json({ ok: false, error: error.message }, 500);
    console.log(`[cron-publisher] peek size=${data?.length || 0}`);
    return json({ ok: true, mode: 'peek', count: data?.length || 0, items: data || [] });
  }

  if (action === 'post') {
    // Step 1: get up to N pending items
    const { data: pending, error: selErr } = await base;
    if (selErr) return json({ ok: false, error: selErr.message }, 500);
    const ids = (pending || []).map(r => r.id);

    if (!ids.length) return json({ ok: true, mode: 'post', claimed: 0, posted: 0, dry_run: dryRun });

    if (dryRun) {
      console.log(`[cron-publisher] DRY-RUN would post ids=${ids.join(',')}`);
      return json({ ok: true, mode: 'post', dry_run: true, would_post_ids: ids, count: ids.length });
    }

    // Step 2: simulate publish by stamping posted_at and posted_result
    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('draft_posts')
      .update({ posted_at: nowIso, posted_result: 'noop' })
      .in('id', ids)
      .is('posted_at', null) // idempotent guard
      .select('id, posted_at, posted_result');
    if (updErr) return json({ ok: false, error: updErr.message }, 500);

    console.log(`[cron-publisher] posted size=${updated?.length || 0}`);
    return json({ ok: true, mode: 'post', dry_run: false, posted: updated?.length || 0, items: updated || [] });
  }

  return json({ ok: false, error: 'bad_action', hint: "Use action=peek or action=post&dry_run=true" }, 400);
}
