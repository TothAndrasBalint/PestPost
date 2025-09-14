import crypto from 'node:crypto';
import { supabaseAdmin } from '../lib/supabase.js';

const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'abc';

// HMAC verify of X-Hub-Signature-256
function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const [scheme, sigHex] = String(header).split('=');
  if (scheme !== 'sha256' || !sigHex) return false;

  const hmac = crypto.createHmac('sha256', secret);
  // Keep using text() + utf8 to match your working version
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

// Minimal extractor from WhatsApp webhook envelope
function parseWaEvent(envelope) {
  try {
    const entry = envelope?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    const from_wa = msg?.from || value?.contacts?.[0]?.wa_id || null;
    const wa_message_id = msg?.id || null;
    const event_type = msg?.type || null;

    return { wa_message_id, from_wa, event_type };
  } catch {
    return { wa_message_id: null, from_wa: null, event_type: null };
  }
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

  // 4) normalize a few fields
  const { wa_message_id, from_wa, event_type } = parseWaEvent(body);

  // 5) idempotent insert into Supabase (events table)
  if (supabaseAdmin) {
    const { error } = await supabaseAdmin
      .from('events')
      .upsert(
        {
          wa_message_id,   // UNIQUE in DB → de-dupe
          from_wa,
          event_type,
          raw: body        // full JSON envelope (jsonb)
        },
        { onConflict: 'wa_message_id', ignoreDuplicates: true }
      );
    if (error) console.error('Supabase upsert error:', error);
  } else {
    console.warn('Supabase env not set; skipping DB insert.');
  }

  // 6) log minimal event for debugging
  console.log('[WA EVENT]', JSON.stringify(
    body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || body
  ));

  // 7) ack to Meta
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
