// /api/wa-send.js  (ESM)
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
const TOKEN = process.env.WA_ACCESS_TOKEN;

export async function POST(request) {
  if (!PHONE_ID || !TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'missing_env' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  let payload;
  try { payload = await request.json(); }
  catch {
    return new Response(JSON.stringify({ ok: false, error: 'bad_json' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const to = String(payload?.to || '').trim();
  const body = String(payload?.body || 'Got it 👌 — processing.').slice(0, 4096);

  if (!to) {
    return new Response(JSON.stringify({ ok: false, error: 'missing_to' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

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
      text: { preview_url: false, body }
    })
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('WA send failed:', data);
    return new Response(JSON.stringify({ ok: false, error: data }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  return new Response(JSON.stringify({ ok: true, data }), {
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
