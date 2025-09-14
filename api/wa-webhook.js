import crypto from 'node:crypto';
import { supabaseAdmin } from '../lib/supabase.js';
import { saveWaMediaById } from '../lib/wa-media.js';

const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'abc';

// Outbound (for optional auto-reply)
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
const TOKEN = process.env.WA_ACCESS_TOKEN;
const AUTO_REPLY = process.env.AUTO_REPLY === '1';

// HMAC verify of X-Hub-Signature-256
function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const [scheme, sigHex] = String(header).split('=');
  if (scheme !== 'sha256' || !sigHex) return false;

  const hmac = crypto.createHmac('sha256', secret);
  // keep utf8 text() path – matches your working version
  hmac.update(rawBody, 'utf8');
  const expected = hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(sigHex, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

// Extract core fields + media_id (if present)
function parseWaEvent(envelope) {
  try {
    const entry = envelope?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    const from_wa = msg?.from || value?.contacts?.[0]?.wa_id || null;
    const wa_message_id = msg?.id || null;
    const event_type = msg?.type || null;

    // media id for common types
    let media_id = null;
    if (event_type === 'image') media_id = msg?.image?.id || null;
    else if (event_type === 'document') media_id = msg?.document?.id || null;
    else if (event_type === 'audio') media_id = msg?.audio?.id || null;
    else if (event_type === 'video') media_id = msg?.video?.id || null;
    else if (event_type === 'sticker') media_id = msg?.sticker?.id || null;

    return { wa_message_id, from_wa, event_type, media_id };
  } catch {
    return { wa_message_id: null, from_wa: null, event_type: null, media_id: null };
  }
}

// Tiny helper to send a text back
async function sendWaText(to, body) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: String(body).slice(0, 4096) }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

export async function GET(request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return new Response(String(challenge), {
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
  return new Response('Forbidden', { status: 403 });
}

export async function POST(request) {
  // 1) raw body for HMAC
  const raw = await request.text();

  // 2) signature check
  const ok = verifySignature(
    raw,
    request.headers.get('x-hub-signature-256'),
    process.env.META_APP_SECRET
  );
  if (!ok) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_signature' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  // 3) parse JSON
  let body;
  try { body = JSON.parse(raw || '{}'); }
  catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_json' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  // 4) normalize a few fields (now includes media_id)
  const { wa_message_id, from_wa, event_type, media_id } = parseWaEvent(body);

  // 5) idempotent insert into Supabase (events table)
  if (supabaseAdmin) {
    const { error } = await supabaseAdmin
      .from('events')
      .upsert(
        { wa_message_id, from_wa, event_type, raw: body },
        { onConflict: 'wa_message_id', ignoreDuplicates: true }
      );
    if (error) console.error('Supabase upsert error:', error);
  } else {
    console.warn('Supabase env not set; skipping DB insert.');
  }

  // 6) if there is media, fetch & upload to Supabase Storage, then write path+mime
  if (media_id) {
    try {
      const { path, mime } = await saveWaMediaById(media_id, wa_message_id);
      console.log('Media saved:', { wa_message_id, media_id, path, mime });
  
      if (supabaseAdmin && wa_message_id) {
        const { error: upErr } = await supabaseAdmin
          .from('events')
          .update({ media_path: path, media_mime: mime })
          .eq('wa_message_id', wa_message_id);
  
        if (upErr) console.error('Supabase update (media_path) error:', upErr);
      }
    } catch (e) {
      console.error('Media save failed:', e.message || e);
    }
  }

  // 7) optional auto-reply
  if (AUTO_REPLY && from_wa && event_type === 'text' && PHONE_ID && TOKEN) {
    try {
      await sendWaText(from_wa, 'PestPost: köszi, megjött 👌 / thanks, received 👌');
    } catch (e) {
      console.error('Auto-reply failed:', e.message || e);
    }
  }

  // 8) ack to Meta
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
