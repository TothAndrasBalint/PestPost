// /api/cron.js
// Tiny proxy that only runs from Vercel Cron and calls the orchestrator internally.

import * as Orchestrator from './cron-orchestrator.js';

const CRON_SECRET = process.env.CRON_SECRET || '';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export async function GET(request) {
  // Only accept calls coming from Vercel Cron (dashboard or scheduled)
  const isVercelCron = !!request.headers.get('x-vercel-cron');
  if (!isVercelCron) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  // Call our internal orchestrator using Bearer auth it already accepts
  const req = new Request('https://internal/cron-orchestrator', {
    headers: { authorization: `Bearer ${CRON_SECRET}` }
  });

  // Delegate to the orchestrator handler
  return Orchestrator.GET(req);
}
