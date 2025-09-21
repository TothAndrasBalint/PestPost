// /api/cron.js
// Tiny proxy that prefers Vercel Cron, but also allows manual runs via ?key= or Bearer.

import * as Orchestrator from './cron-orchestrator.js';

const CRON_SECRET   = process.env.CRON_SECRET || '';
const CRON_ORCH_KEY = process.env.CRON_ORCH_KEY || '';
const CRON_TOKEN    = process.env.CRON_TOKEN || process.env.ADMIN_API_TOKEN || '';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export async function GET(request) {
  const url = new URL(request.url);
  const isVercelCron = !!request.headers.get('x-vercel-cron');
  const keyParam = url.searchParams.get('key') || '';
  const hdr = request.headers.get('authorization') || '';
  const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7) : null;

  const allowed =
    isVercelCron ||
    (CRON_ORCH_KEY && keyParam === CRON_ORCH_KEY) ||
    (CRON_SECRET && bearer === CRON_SECRET) ||
    (CRON_TOKEN && bearer === CRON_TOKEN);

  if (!allowed) return json({ ok: false, error: 'forbidden' }, 403);

  // Call the internal orchestrator with a Bearer it accepts
  const auth = new Headers({
    authorization: `Bearer ${CRON_SECRET || CRON_TOKEN || ''}`
  });
  const req = new Request('https://internal/cron-orchestrator', { headers: auth });
  return Orchestrator.GET(req);
}
