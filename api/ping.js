export function GET() {
  return new Response('pong', {
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  });
}

