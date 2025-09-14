function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true, env: process.env.APP_ENV || 'unknown' }));
}
module.exports = handler;
module.exports.default = handler;
exports.default = handler;
