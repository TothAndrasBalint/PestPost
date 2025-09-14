// /api/admin-drafts.js
import { supabaseAdmin } from '../lib/supabase.js';

const TOKEN = process.env.ADMIN_API_TOKEN;

export async function GET(request) {
  // --- simple token guard (header or query) ---
  const url = new URL(request.url);
  const hdr = request.headers.get('authorization') || '';
  const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7) : null;
  const qtok = url.searchParams.get('token');
  const provided = bearer || qtok || '';
  if (!TOKEN || provided !== TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  // --- paging params ---
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10), 1), 100);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);

  if (!supabaseAdmin) {
    return new Response(JSON.stringify({ ok: false, error: 'no_db' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const { data, error } = await supabaseAdmin
    .from('draft_posts')
    .select('id, created_at, source_message_id, from_wa, text_body, media_path, media_mime, status')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  return new Response(JSON.stringify({ ok: true, count: data?.length || 0, items: data }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
