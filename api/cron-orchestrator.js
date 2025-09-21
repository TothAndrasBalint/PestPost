// /api/cron-orchestrator.js
import * as Scheduler from './cron-scheduler.js';
import * as Runner from './cron-runner.js';
import * as Publisher from './cron-publisher.js';

const CRON_TOKEN = process.env.CRON_TOKEN || process.env.ADMIN_API_TOKEN;
const CRON_ORCH_KEY = process.env.CRON_ORCH_KEY; // set this in Vercel envs

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
  const key = url.searchParams.get('key') || '';
  const fromCron = request.headers.get('x-vercel-cron'); // present when invoked by Vercel Cron

  // Allow EITHER a secret key (?key=...) OR Bearer token for manual runs.
  const allowed =
    (CRON_ORCH_KEY && key && key === CRON_ORCH_KEY) ||
    (CRON_TOKEN && bearer && bearer === CRON_TOKEN);

  if (!allowed) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const authHeaders = new Headers({ authorization: `Bearer ${CRON_TOKEN || ''}` });

  // 1) Plan AI slots (sheetless JSON windows)
  const planReq = new Request('https://internal/cron-scheduler?action=plan', { headers: authHeaders });
  const planRes = await Scheduler.GET(planReq).then(r => r.json()).catch(e => ({ ok:false, error:String(e) }));

  // 2) Claim due items (avoid double picks)
  const claimReq = new Request('https://internal/cron-runner?action=claim&limit=50', { headers: authHeaders });
  const claimRes = await Runner.GET(claimReq).then(r => r.json()).catch(e => ({ ok:false, error:String(e) }));

  // 3) Post (stub → marks posted_at)
  const postReq = new Request('https://internal/cron-publisher?action=post&limit=50', { headers: authHeaders });
  const postRes = await Publisher.GET(postReq).then(r => r.json()).catch(e => ({ ok:false, error:String(e) }));

  // Lightweight log
  console.log('[cron-orchestrator]', {
    fromCron: !!fromCron,
    plan: planRes?.mode ? `${planRes.mode}:${planRes.planned ?? planRes.count ?? 0}` : 'err',
    claim: claimRes?.mode ? `${claimRes.mode}:${claimRes.claimed ?? claimRes.count ?? 0}` : 'err',
    post: postRes?.mode ? `${postRes.mode}:${postRes.posted ?? postRes.count ?? 0}` : 'err',
  });

  return json({ ok: true, plan: planRes, claim: claimRes, post: postRes });
}
