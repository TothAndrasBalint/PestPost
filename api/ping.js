function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('pong');
}
module.exports = handler;          // CJS
module.exports.default = handler;  // make sure "default" exists too
exports.default = handler;
