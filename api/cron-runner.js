// /api/cron-runner.js  (v0 — read-only)
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

  if (!supabaseAdmin) return json({ ok: false, error: 'no_db' }, 500);

  // Paging (optional)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10), 1), 500);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);

  const nowIso = new Date().toISOString();

  // Due = approved & scheduled_at not null & scheduled_at <= now
  const q = supabaseAdmin
    .from('draft_posts')
    .select('id, from_wa, source_message_id, status, approved_at, scheduled_at')
    .eq('status', 'approved')
    .not('scheduled_at', 'is', null)
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error } = await q;
  if (error) return json({ ok: false, error: error.message }, 500);

  // Lightweight logging for observability
  console.log(`[cron-runner] due=${data?.length || 0} at ${nowIso}`);

  return json({ ok: true, now: nowIso, count: data?.length || 0, items: data || [] });
}
