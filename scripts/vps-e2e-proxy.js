const http = require('node:http');
const https = require('node:https');

if (!process.env.SANDWICH_E2E_TARGET) throw new Error('SANDWICH_E2E_TARGET is required');
const target = new URL(process.env.SANDWICH_E2E_TARGET);
const targetIp = process.env.SANDWICH_E2E_RESOLVE_IP;
const port = Number(process.env.SANDWICH_E2E_PROXY_PORT || 18767);

if (!targetIp) throw new Error('SANDWICH_E2E_RESOLVE_IP is required');

const server = http.createServer((request, response) => {
  const headers = { ...request.headers, host: target.host };
  delete headers.connection;
  const upstream = https.request({
    hostname: targetIp,
    port: target.port || 443,
    servername: target.hostname,
    method: request.method,
    path: request.url,
    headers
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', error => {
    response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`upstream error: ${error.message}`);
  });
  request.pipe(upstream);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`VPS E2E proxy http://127.0.0.1:${port} -> ${target.hostname} (${targetIp})`);
});
