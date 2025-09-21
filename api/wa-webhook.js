import crypto from 'node:crypto';
import { supabaseAdmin } from '../lib/supabase.js';
import { saveWaMediaById } from '../lib/wa-media.js';
import { generateCaptionAndTags } from '../lib/generate.js'; // NEW: AI caption generator
import { parseConstraints } from '../lib/constraints.js';

const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'abc';

// Outbound (optional auto-reply)
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
const TOKEN = process.env.WA_ACCESS_TOKEN;
const AUTO_REPLY = process.env.AUTO_REPLY === '1';

// -------- helpers --------

async function recordEvent(supabase, row) {
  // Guard against bad rows
  if (!row || !row.wa_message_id) {
    console.warn('events: skip insert (missing wa_message_id)');
    return;
  }
  const { error } = await supabase
    .from('events')
    .upsert(
      {
        wa_message_id: row.wa_message_id,  // UNIQUE idempotency
        from_wa: row.from_wa || null,
        event_type: row.event_type || null,
        raw: row.raw ?? null
      },
      { onConflict: 'wa_message_id', ignoreDuplicates: true }
    );
  if (error) console.error('events upsert error:', error);
}

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

// Extract core fields, media_id, and text (or caption)
// NOW also supports interactive.button_reply (returns interactive_id)
function parseWaEvent(envelope) {
  try {
    const entry = envelope?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    const from_wa = msg?.from || value?.contacts?.[0]?.wa_id || null;
    const wa_message_id = msg?.id || null;
    const event_type = msg?.type || null;

    let media_id = null;
    let text_body = null;
    let interactive_id = null; // NEW

    if (event_type === 'text') {
      text_body = msg?.text?.body ?? null;
    } else if (event_type === 'image') {
      media_id = msg?.image?.id || null;
      text_body = msg?.image?.caption ?? null;
    } else if (event_type === 'document') {
      media_id = msg?.document?.id || null;
      text_body = msg?.document?.caption ?? null;
    } else if (event_type === 'audio') {
      media_id = msg?.audio?.id || null;
    } else if (event_type === 'video') {
      media_id = msg?.video?.id || null;
      text_body = msg?.video?.caption ?? null;
    } else if (event_type === 'sticker') {
      media_id = msg?.sticker?.id || null;
    } else if (event_type === 'interactive') { // NEW
      if (msg?.interactive?.type === 'button_reply') {
        // e.g., "approve:123", "request_edit:123", "postnow:123", "aisched:123"
        interactive_id = msg?.interactive?.button_reply?.id || null;
      }
    }

    return { wa_message_id, from_wa, event_type, media_id, text_body, interactive_id };
  } catch {
    return {
      wa_message_id: null,
      from_wa: null,
      event_type: null,
      media_id: null,
      text_body: null,
      interactive_id: null
    };
  }
}

// Tiny helpers
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------- routes --------

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

  // 3.5) STATUS callbacks (sent/delivered/read/failed) — log them and ACK early
  // These arrive after you send a preview; they do NOT have value.messages[0].id,
  // but they DO have value.statuses[].id (the message id the status refers to).
  {
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    let sawStatus = false;

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const statuses = change?.value?.statuses;
        if (Array.isArray(statuses) && statuses.length) {
          sawStatus = true;
          for (const s of statuses) {
            await recordEvent(supabaseAdmin, {
              wa_message_id: s.id,                  // message id referenced by this status
              from_wa: s.recipient_id || null,      // number we sent to
              event_type: `status:${s.status}`,     // e.g. status:sent | status:delivered
              raw: s
            });
          }
        }
      }
    }

    if (sawStatus) {
      return new Response(JSON.stringify({ ok: true, kind: 'status' }), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }
  }

  // 4) normalize fields (now includes media_id + text_body + interactive_id)
  const { wa_message_id, from_wa, event_type, media_id, text_body, interactive_id } = parseWaEvent(body);

  // 5) idempotent insert into Supabase (events log) — only if we have a message id
  if (supabaseAdmin) {
    if (wa_message_id) {
      const { error } = await supabaseAdmin
        .from('events')
        .upsert(
          { wa_message_id, from_wa, event_type, raw: body },
          { onConflict: 'wa_message_id', ignoreDuplicates: true }
        );
      if (error) console.error('Supabase upsert error:', error);
    } else {
      // No message id → could be other webhook shapes, but we already handled statuses above.
      console.warn('events: skip insert (no wa_message_id on this payload)');
    }
  } else {
    console.warn('Supabase env not set; skipping DB insert.');
  }

  // --- Handle Approve button (interactive.button_reply) and exit early ---
  if (event_type === 'interactive' && interactive_id && interactive_id.startsWith('approve:')) {
    const idStr = interactive_id.split(':')[1];
    const draftId = Number(idStr);
  
    if (Number.isFinite(draftId) && supabaseAdmin) {
      // Update only if NOT already approved; return the row if it changed
      const { data: updated, error: upErr } = await supabaseAdmin
        .from('draft_posts')
        .update({ status: 'approved', approved_at: new Date().toISOString() })
        .eq('id', draftId)
        .neq('status', 'approved')          // idempotency guard
        .select('id')
        .maybeSingle();
  
      if (upErr) {
        console.error('approve update failed:', upErr);
      } else if (updated) {
        // We actually approved it just now — send thank-you + scheduling buttons
        if (from_wa && PHONE_ID && TOKEN) {
          try { await sendWaText(from_wa, 'Approved ✅ — thanks!'); } catch {}
          try {
            await sleep(1200);
            const endpoint = `https://graph.facebook.com/v20.0/${PHONE_ID}/messages`;
            const schedButtons = {
              messaging_product: 'whatsapp',
              to: from_wa,
              type: 'interactive',
              interactive: {
                type: 'button',
                body: { text: 'When should I schedule it?' },
                action: {
                  buttons: [
                    { type: 'reply', reply: { id: `postnow:${draftId}`, title: 'Post now' } },
                    { type: 'reply', reply: { id: `aisched:${draftId}`, title: 'Let AI schedule' } }
                  ]
                }
              }
            };
            await fetch(endpoint, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(schedButtons)
            });
          } catch (e) {
            console.error('send scheduling buttons failed:', e?.message || e);
          }
        }
      } else {
        // Already approved earlier — do nothing (prevents duplicate messages)
        console.log('approve: already approved, skipping messages', { draftId });
      }
    }
  
    return new Response(JSON.stringify({ ok: true, kind: 'interactive:approve' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }


  // --- Handle Post now (scheduling) ---
  if (event_type === 'interactive' && interactive_id && interactive_id.startsWith('postnow:')) {
    const idStr = interactive_id.split(':')[1];
    const draftId = Number(idStr);

    if (Number.isFinite(draftId) && supabaseAdmin) {
      try {
        await supabaseAdmin
          .from('draft_posts')
          .update({
            schedule_strategy: 'now',
            scheduled_at: new Date().toISOString()
          })
          .eq('id', draftId);

        if (from_wa && PHONE_ID && TOKEN) {
          try { await sendWaText(from_wa, 'Queued now. 📥'); } catch {}
        }
      } catch (e) {
        console.error('postnow update failed:', e?.message || e);
      }
    }

    return new Response(JSON.stringify({ ok: true, kind: 'schedule:now' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  // --- Handle Let AI schedule (scheduling) ---
  if (event_type === 'interactive' && interactive_id && interactive_id.startsWith('aisched:')) {
    const idStr = interactive_id.split(':')[1];
    const draftId = Number(idStr);

    if (Number.isFinite(draftId) && supabaseAdmin) {
      try {
        await supabaseAdmin
          .from('draft_posts')
          .update({
            schedule_strategy: 'ai',
            scheduled_at: null // to be set by your AI scheduler later
          })
          .eq('id', draftId);

        if (from_wa && PHONE_ID && TOKEN) {
          try { await sendWaText(from_wa, 'Okay — I’ll queue this for AI scheduling. 🤖'); } catch {}
        }
      } catch (e) {
        console.error('aisched update failed:', e?.message || e);
      }
    }

    return new Response(JSON.stringify({ ok: true, kind: 'schedule:ai' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  // --- Handle Request edit button (interactive.button_reply) and exit early ---
  if (event_type === 'interactive' && interactive_id && interactive_id.startsWith('request_edit:')) {
    const idStr = interactive_id.split(':')[1];
    const draftId = Number(idStr);

    if (Number.isFinite(draftId) && supabaseAdmin) {
      try {
        // Ensure only ONE awaiting_edit per user: clear any previous flags for this number
        if (from_wa) {
          await supabaseAdmin
            .from('draft_posts')
            .update({ awaiting_edit: false })
            .eq('from_wa', from_wa)
            .eq('awaiting_edit', true);
        }

        // Mark THIS draft as awaiting an edit message from the user
        await supabaseAdmin
          .from('draft_posts')
          .update({ awaiting_edit: true })
          .eq('id', draftId);
      } catch (e) {
        console.error('set awaiting_edit failed:', e?.message || e);
      }
    }

    // Prompt the user for what to tweak
    if (from_wa && PHONE_ID && TOKEN) {
      try {
        await sendWaText(
          from_wa,
          "Okay ✍️ — what should I tweak (image or caption)? You can just say the change (e.g., brighter image, shorter text, mention opening hours) and I’ll resend."
        );
      } catch {}
    }

    return new Response(JSON.stringify({ ok: true, kind: 'interactive:request_edit' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  // --- Consume next text when awaiting_edit is true (AI caption placeholder flow) ---
  if (event_type === 'text' && from_wa && text_body && supabaseAdmin) {
    // find the most recent draft marked awaiting_edit for this number
    const { data: awaitingRows, error: awaitingErr } = await supabaseAdmin
      .from('draft_posts')
      .select('*')
      .eq('from_wa', from_wa)
      .eq('awaiting_edit', true)
      .order('id', { ascending: false })
      .limit(1);

    if (!awaitingErr && awaitingRows && awaitingRows.length) {
      const parent = awaitingRows[0];

      // clear awaiting flag on parent (best-effort)
      try {
        await supabaseAdmin.from('draft_posts').update({ awaiting_edit: false }).eq('id', parent.id);
      } catch {}

      // create a new draft (placeholder variant): reuse image, set caption to user's text
      const newDraft = {
        source_message_id: wa_message_id,     // current text message
        from_wa,
        text_body,                            // DB keeps raw user text for now
        media_path: parent.media_path || null,
        media_mime: parent.media_mime || null,
        status: 'draft'
      };

      const { data: inserted, error: draftErr } = await supabaseAdmin
        .from('draft_posts')
        .upsert(newDraft, { onConflict: 'source_message_id' })
        .select()
        .single();

      if (draftErr) {
        console.error('create placeholder variant failed:', draftErr);
      } else if (PHONE_ID && TOKEN) {
        // Build the preview caption using AI, using user steering constraints
        let previewCaption = text_body;
        try {
          const constraints = parseConstraints(text_body);
          const { caption_final, hashtags } = await generateCaptionAndTags({
            seedText: text_body,
            constraints,
            clientPrefs: {} // keep as-is for now
          });
          const tagLine = (hashtags && hashtags.length) ? '\n\n' + hashtags.join(' ') : '';
          previewCaption = (caption_final || text_body) + tagLine;
        } catch (e) {
          console.error('AI caption generation failed, using user text:', e?.message || e);
        }


        // send preview (image+caption if media, else text), then buttons tied to it
        try {
          const endpoint = `https://graph.facebook.com/v20.0/${PHONE_ID}/messages`;

          // First message: media or text
          let firstMsgId = null;
          if (inserted.media_path) {
            // sign a private URL for 5 minutes
            const { data: signed } = await supabaseAdmin
              .storage.from('media')
              .createSignedUrl(inserted.media_path, 300);
            const link = signed?.signedUrl || null;

            const payload1 = link
              ? {
                  messaging_product: 'whatsapp',
                  to: from_wa,
                  type: 'image',
                  image: { link, caption: previewCaption } // <-- uses AI caption
                }
              : {
                  messaging_product: 'whatsapp',
                  to: from_wa,
                  type: 'text',
                  text: { preview_url: false, body: previewCaption } // <-- uses AI caption
                };

            const res1 = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(payload1)
            });
            const j1 = await res1.json();
            if (res1.ok && Array.isArray(j1?.messages)) {
              firstMsgId = j1.messages[0]?.id || null;
            } else {
              console.error('send preview failed:', j1);
            }
          } else {
            // text-only preview
            const payload1 = {
              messaging_product: 'whatsapp',
              to: from_wa,
              type: 'text',
              text: { preview_url: false, body: previewCaption } // <-- uses AI caption
            };
            const res1 = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(payload1)
            });
            const j1 = await res1.json();
            if (res1.ok && Array.isArray(j1?.messages)) {
              firstMsgId = j1.messages[0]?.id || null;
            } else {
              console.error('send text preview failed:', j1);
            }
          }

          // wait so the image lands first
          await sleep(3500);

          // Second message: buttons (tie to the first message via context if available)
          const buttons = {
            messaging_product: 'whatsapp',
            to: from_wa,
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text: 'Approve this post, or request edits.' },
              action: {
                buttons: [
                  { type: 'reply', reply: { id: `approve:${inserted.id}`,      title: 'Approve ✅' } },
                  { type: 'reply', reply: { id: `request_edit:${inserted.id}`, title: 'Request edit ✍️' } }
                ]
              }
            }
          };
          if (firstMsgId) buttons.context = { message_id: firstMsgId };

          const res2 = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(buttons)
          });
          const j2 = await res2.json();
          if (!res2.ok) console.error('send buttons failed:', j2);
        } catch (e) {
          console.error('preview+buttons send error:', e?.message || e);
        }
      }

      // ACK and exit (do not run the normal draft creation below)
      return new Response(JSON.stringify({ ok: true, kind: 'edit_captured' }), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }
  }

  // Keep track of saved media for draft creation
  let savedPath = null;
  let savedMime = null;

  // 6) if media present: fetch & upload → update events row with media path/mime
  if (media_id) {
    try {
      const { path, mime } = await saveWaMediaById(media_id, wa_message_id);
      savedPath = path;
      savedMime = mime;
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

  // 7) create/ensure a draft_post (idempotent on source_message_id)
  if (supabaseAdmin && wa_message_id) {
    const draft = {
      source_message_id: wa_message_id,
      from_wa: from_wa || null,
      text_body: text_body || null,
      media_path: savedPath || null,
      media_mime: savedMime || null,
      status: 'draft'
    };

    const { error: draftErr } = await supabaseAdmin
      .from('draft_posts')
      .upsert(draft, { onConflict: 'source_message_id', ignoreDuplicates: true });

    if (draftErr) console.error('Supabase upsert (draft_posts) error:', draftErr);
    else console.log('Draft created:', { source_message_id: wa_message_id });
  }

  // 8) optional auto-reply
  if (AUTO_REPLY && from_wa && event_type === 'text' && PHONE_ID && TOKEN) {
    try {
      await sendWaText(from_wa, 'PestPost: köszi, megjött 👌 / thanks, received 👌');
    } catch (e) {
      console.error('Auto-reply failed:', e.message || e);
    }
  }

  // 9) ack to Meta
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
