export function GET() {
  const env = process.env.APP_ENV || 'unknown';
  return new Response(JSON.stringify({ ok: true, env }), {
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
