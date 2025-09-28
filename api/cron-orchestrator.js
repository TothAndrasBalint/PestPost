// /api/cron-orchestrator.js
import * as Scheduler from './cron-scheduler.js';
import * as Runner from './cron-runner.js';
import * as Publisher from './cron-publisher.js';
import { supabaseAdmin } from '../lib/supabase.js';

const DRAFT_EXPIRY_SECONDS = Number(process.env.DRAFT_EXPIRY_SECONDS || 3600); // 1h
const CRON_TOKEN    = process.env.CRON_TOKEN || process.env.ADMIN_API_TOKEN || '';
const CRON_SECRET   = process.env.CRON_SECRET || ''; // Vercel Cron sends: Authorization: Bearer <CRON_SECRET>
const CRON_ORCH_KEY = process.env.CRON_ORCH_KEY || ''; // optional ?key=... fallback

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export async function GET(request) {
  const url = new URL(request.url);
  const hdr = request.headers.get('authorization') || '';
  const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7) : null;
  const keyParam = url.searchParams.get('key') || '';
  const fromCron = !!request.headers.get('x-vercel-cron');

  // Allow EITHER: CRON_SECRET (Vercel Cron) OR CRON_TOKEN (manual) OR ?key=CRON_ORCH_KEY
  const authorized =
    (CRON_SECRET && bearer === CRON_SECRET) ||
    (CRON_TOKEN && bearer === CRON_TOKEN)   ||
    (CRON_ORCH_KEY && keyParam === CRON_ORCH_KEY);

  if (!authorized) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  // Token used to call internal stages
  const internalToken = CRON_TOKEN || CRON_SECRET;
  if (!internalToken) return json({ ok: false, error: 'no_internal_token' }, 500);

  const authHeaders = new Headers({ authorization: `Bearer ${internalToken}` });

  try {
    // 1) Plan (assign scheduled_at for AI strategy)
    const planReq = new Request('https://internal/cron-scheduler?action=plan', { headers: authHeaders });
    const planRes = await Scheduler.GET(planReq).then(r => r.json());

    // 2) Claim (avoid double picks)
    const claimReq = new Request('https://internal/cron-runner?action=claim&limit=50', { headers: authHeaders });
    const claimRes = await Runner.GET(claimReq).then(r => r.json());

    // 3) Post (stub → marks posted_at)
    const postReq = new Request('https://internal/cron-publisher?action=post&limit=50', { headers: authHeaders });
    const postRes = await Publisher.GET(postReq).then(r => r.json());

    console.log('[cron-orchestrator]', {
      fromCron,
      plan: planRes?.mode ? `${planRes.mode}:${planRes.planned ?? planRes.count ?? 0}` : 'err',
      claim: claimRes?.mode ? `${claimRes.mode}:${claimRes.claimed ?? claimRes.count ?? 0}` : 'err',
      post: postRes?.mode ? `${postRes.mode}:${postRes.posted ?? postRes.count ?? 0}` : 'err'
    });

    return json({ ok: true, plan: planRes, claim: claimRes, post: postRes });
  } catch (e) {
    console.error('[cron-orchestrator] error', e);
    return json({ ok: false, error: String(e) }, 500);
  }
}
