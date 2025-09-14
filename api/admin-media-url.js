// /api/admin-media-url.js
import { supabaseAdmin } from '../lib/supabase.js';
const TOKEN = process.env.ADMIN_API_TOKEN;

// GET ?token=...&path=wa/2025/09/14/xxx.jpg&expires=300
export async function GET(request) {
  const url = new URL(request.url);

  // auth
  const hdr = request.headers.get('authorization') || '';
  const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7) : null;
  const provided = bearer || url.searchParams.get('token') || '';
  if (!TOKEN || provided !== TOKEN) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const path = url.searchParams.get('path') || '';
  const expires = Math.min(Math.max(parseInt(url.searchParams.get('expires') || '300', 10), 60), 3600);

  if (!path) return json({ ok: false, error: 'missing path' }, 400);
  if (!supabaseAdmin) return json({ ok: false, error: 'no_db' }, 500);

  const { data, error } = await supabaseAdmin
    .storage
    .from('media')
    .createSignedUrl(path, expires);

  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, url: data?.signedUrl || null, expires });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
