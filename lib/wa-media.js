// lib/wa-media.js
// Helper to: (1) turn a WhatsApp media_id into a signed URL,
// (2) download the binary, and (3) upload to Supabase Storage.

import { supabaseAdmin } from './supabase.js';

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';
const TOKEN = process.env.WA_ACCESS_TOKEN;

// Small MIME → extension map (fallback to 'bin')
const EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

function pickExt(mime = '') {
  return EXT[mime.toLowerCase()] || 'bin';
}

function yyyymmddParts(d = new Date()) {
  const yyyy = `${d.getUTCFullYear()}`;
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return { yyyy, mm, dd };
}

/**
 * Get a short-lived media URL + mime from WhatsApp Graph by media_id
 * @param {string} mediaId
 * @returns {Promise<{url:string, mime:string}>}
 */
export async function getWaMediaUrl(mediaId) {
  if (!TOKEN) throw new Error('WA_ACCESS_TOKEN is missing');
  const metaRes = await fetch(`${GRAPH_BASE}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const meta = await metaRes.json();
  if (!metaRes.ok) {
    throw new Error(`media meta error: ${JSON.stringify(meta)}`);
  }
  // meta typically contains { id, url, mime_type, file_size }
  return { url: meta.url, mime: meta.mime_type || '' };
}

/**
 * Download the media binary from a Graph-provided URL
 * @param {string} url
 * @returns {Promise<{buffer:Uint8Array, mime:string}>}
 */
export async function downloadWaMedia(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`media download failed: ${res.status} ${txt}`);
  }
  const mime = res.headers.get('content-type') || '';
  const buf = new Uint8Array(await res.arrayBuffer());
  return { buffer: buf, mime };
}

/**
 * Upload a binary to Supabase Storage /media and return the storage path
 * @param {Uint8Array} buffer
 * @param {string} mime
 * @param {string} waMessageId
 * @returns {Promise<string>} storage path (e.g., wa/2025/09/14/<id>.jpg)
 */
export async function uploadToSupabase(buffer, mime, waMessageId) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { yyyy, mm, dd } = yyyymmddParts();
  const ext = pickExt(mime);
  const path = `wa/${yyyy}/${mm}/${dd}/${waMessageId || crypto.randomUUID()}.${ext}`;

  const { error } = await supabaseAdmin.storage
    .from('media')
    .upload(path, buffer, { contentType: mime || 'application/octet-stream', upsert: true });

  if (error) throw new Error(`supabase upload error: ${error.message}`);
  return path;
}

/**
 * High-level convenience:
 * Given a WhatsApp media_id, fetch + upload, return { path, mime }
 */
export async function saveWaMediaById(mediaId, waMessageId) {
  const { url, mime: metaMime } = await getWaMediaUrl(mediaId);
  const { buffer, mime: dlMime } = await downloadWaMedia(url);
  const mime = dlMime || metaMime || 'application/octet-stream';
  const path = await uploadToSupabase(buffer, mime, waMessageId);
  return { path, mime };
}
