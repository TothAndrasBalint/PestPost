// /api/cron-scheduler.js  (Option C • sheetless, JSON-driven)
import { supabaseAdmin } from '../lib/supabase.js';
import { loadWindows, nextSlotSimple } from '../lib/scheduling.js';

const CRON_TOKEN = process.env.CRON_TOKEN || process.env.ADMIN_API_TOKEN;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export async function GET(request) {
  // --- auth ---
  const url = new URL(request.url);
  const hdr = request.headers.get('authorization') || '';
  const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7) : null;
  const provided = bearer || url.searchParams.get('token') || '';
  if (!CRON_TOKEN || provided !== CRON_TOKEN) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const action  = (url.searchParams.get('action') || 'peek').toLowerCase(); // peek | plan
  const dryRun  = (url.searchParams.get('dry_run') || 'false').toLowerCase() === 'true';
  const limit   = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10), 1), 200);
  const nowUtc  = new Date();

  // 1) Load global windows JSON (Option C)
  const windows = await loadWindows();

  // 2) Find items needing scheduling
  const { data: need, error: selErr } = await supabaseAdmin
    .from('draft_posts')
    .select('id, from_wa, source_message_id, status, schedule_strategy, scheduled_at')
    .eq('status', 'approved')
    .eq('schedule_strategy', 'ai')
    .is('scheduled_at', null)
    .order('id', { ascending: true })
    .limit(limit);

  if (selErr) return json({ ok: false, error: selErr.message }, 500);

  if (action === 'peek') {
    return json({ ok: true, mode: 'peek', count: need?.length || 0, items: need || [] });
  }

  // 3) PLAN: compute a time per row (respecting simple cooldown + jitter)
  const computed = (need || []).map(r => ({
    id: r.id,
    scheduled_at: nextSlotSimple({ windows, nowUtc })
  }));

  if (dryRun) {
    return json({ ok: true, mode: 'plan', dry_run: true, planned: computed.length, items: computed });
  }

  // 4) Write back per row (distinct timestamp per id)
  const results = [];
  for (const u of computed) {
    const { data, error } = await supabaseAdmin
      .from('draft_posts')
      .update({ scheduled_at: u.scheduled_at })
      .eq('id', u.id)
      .is('scheduled_at', null)      // idempotent guard
      .select('id, scheduled_at')
      .single();
    if (error) {
      results.push({ id: u.id, error: error.message });
    } else {
      results.push(data);
    }
  }

  const okItems = results.filter(x => x && x.id);
  return json({ ok: true, mode: 'plan', planned: okItems.length, items: okItems });
}
