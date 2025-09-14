// /api/admin-approve.js
import { supabaseAdmin } from '../lib/supabase.js';

const TOKEN = process.env.ADMIN_API_TOKEN;

// Accepts GET ?token=...&id=123  OR  ?token=...&source=wamid....
// (POST with JSON { id } or { source } also supported.)
export async function GET(request) { return handle(request); }
export async function POST(request) { return handle(request); }

async function handle(request) {
  const url = new URL(request.url);

  // --- auth ---
  const hdr = request.headers.get('authorization') || '';
  const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7) : null;
  const qtok = url.searchParams.get('token');
  const provided = bearer || qtok || '';
  if (!TOKEN || provided !== TOKEN) return json({ ok: false, error: 'unauthorized' }, 401);

  // --- input ---
  let id = url.searchParams.get('id');
  let source = url.searchParams.get('source');

  if (request.method === 'POST') {
    try {
      const b = await request.json();
      if (!id && b?.id != null) id = String(b.id);
      if (!source && b?.source) source = String(b.source);
    } catch {}
  }

  if (!id && !source) return json({ ok: false, error: 'missing id or source' }, 400);
  if (!supabaseAdmin) return json({ ok: false, error: 'no_db' }, 500);

  // --- find the draft ---
  let query = supabaseAdmin.from('draft_posts').select('*').limit(1);
  if (id) query = query.eq('id', Number(id));
  else query = query.eq('source_message_id', source);

  const { data: rows, error: selErr } = await query;
  if (selErr) return json({ ok: false, error: selErr.message }, 500);

  const row = rows?.[0];
  if (!row) return json({ ok: false, error: 'not_found' }, 404);

  // If already approved, return as-is (don’t overwrite timestamps/captions)
  if (row.status === 'approved') return json({ ok: true, already: true, item: row });

  // --- build updates: status + (first-time) caption_seed + approved_at ---
  const updates = { status: 'approved' };
  if (!row.caption_seed) updates.caption_seed = row.text_body || null;
  if (!row.approved_at) updates.approved_at = new Date().toISOString();

  let upd = supabaseAdmin.from('draft_posts').update(updates);
  if (id) upd = upd.eq('id', Number(id));
  else upd = upd.eq('source_message_id', source);

  const { error: updErr } = await upd;
  if (updErr) return json({ ok: false, error: updErr.message }, 500);

  // return refreshed row
  const { data: after } = await supabaseAdmin
    .from('draft_posts')
    .select('*')
    .eq(id ? 'id' : 'source_message_id', id ? Number(id) : source)
    .limit(1);

  return json({ ok: true, item: after?.[0] || null });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
