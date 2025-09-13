export default function handler(req, res) {
  if (req.method === 'GET') {
    const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: challenge } = req.query;
    if (mode === 'subscribe' && token === 'abc' && challenge != null) {
      res.status(200).setHeader('Content-Type', 'text/plain').send(String(Number(challenge)));
      return;
    }
    res.status(403).send('Forbidden');
    return;
  }

  if (req.method === 'POST') {
    console.log('WA webhook POST:', req.body);
    res.status(200).send('ok');
    return;
  }

  res.status(200).send('ok');
}

