// /api/admin-send-preview.js
import { supabaseAdmin } from '../lib/supabase.js';

const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_TOKEN  = process.env.WA_ACCESS_TOKEN;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

// GET ?token=...&id=123  OR  ?token=...&source=wamid....
// Sends either:
//  - text-only: caption
//  - image+caption: signed URL of media_path + caption
// Then sends a second message with interactive buttons for approval.
export async function GET(req) { return handle(req); }
export async function POST(req) { return handle(req); }

async function handle(request) {
  const url = new URL(request.url);

  // --- auth ---
  const hdr = request.headers.get('authorization') || '';
  const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7) : null;
  const provided = bearer || url.searchParams.get('token') || '';
  if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

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
  if (!PHONE_ID || !WA_TOKEN) return json({ ok: false, error: 'missing_wa_env' }, 500);

  // --- load draft ---
  let q = supabaseAdmin.from('draft_posts').select('*').limit(1);
  if (id) q = q.eq('id', Number(id)); else q = q.eq('source_message_id', source);
  const { data: rows, error: selErr } = await q;
  if (selErr) return json({ ok: false, error: selErr.message }, 500);
  const draft = rows?.[0];
  if (!draft) return json({ ok: false, error: 'not_found' }, 404);

  const to = (draft.from_wa || '').trim();
  if (!to) return json({ ok: false, error: 'missing_to_number' }, 400);

  // Prefer final caption if available, then seed, then text body
  const caption = draft.caption_final || draft.caption_seed || draft.text_body || 'Preview';

  // --- if media exists, create a signed URL for a few minutes
  let mediaSignedUrl = null;
  if (draft.media_path) {
    const { data, error } = await supabaseAdmin.storage
      .from('media')
      .createSignedUrl(draft.media_path, 300); // 5 minutes
    if (error) return json({ ok: false, error: `sign_url: ${error.message}` }, 500);
    mediaSignedUrl = data?.signedUrl || null;
  }

  // --- send to WhatsApp (message 1: media or text) ---
  const endpoint = `https://graph.facebook.com/v20.0/${PHONE_ID}/messages`;

  let payload;
  if (mediaSignedUrl) {
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: mediaSignedUrl, caption }
    };
  } else {
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: caption }
    };
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok) {
    return json({ ok: false, error: data }, 500);
  }

  // Ensure buttons follow the media/text message in the UI
  const firstMsgId = Array.isArray(data?.messages) ? data.messages[0]?.id : null;
  
  // Small delay helps ordering on some clients/networks
  await new Promise(r => setTimeout(r, 700));

  // --- send to WhatsApp (message 2: interactive buttons) ---
  // Note: WA non-template interactive buttons cannot be combined with media; must be a separate message.
  const buttonsPayload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    // Reply to the first message so it stacks underneath
    context: firstMsgId ? { message_id: firstMsgId } : undefined,
    interactive: {
      type: 'button',
      body: { text: 'Approve this post, or request edits.' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `approve:${draft.id}`,      title: 'Approve ✅' } },
          { type: 'reply', reply: { id: `request_edit:${draft.id}`, title: 'Request edit ✍️' } }
        ]
      }
    }
  };

  let buttonsOk = true;
  let buttonsResp = null;
  try {
    const res2 = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buttonsPayload)
    });
    buttonsResp = await res2.json();
    if (!res2.ok) buttonsOk = false;
  } catch (e) {
    buttonsOk = false;
    buttonsResp = { error: String(e?.message || e) };
  }

  return json({
    ok: true,
    to,
    kind: payload.type,
    data,                    // first message response
    buttons_ok: buttonsOk,   // true/false
    buttons: buttonsResp     // second message response or error info
  });
}
