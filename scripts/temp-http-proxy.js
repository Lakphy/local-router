const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { URL } = require('node:url');

const host = process.env.PROXY_HOST || '127.0.0.1';
const port = Number(process.env.PROXY_PORT || '7890');
const logFile = process.env.PROXY_LOG_FILE || '/tmp/local-router-test-proxy.log';

function log(event, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...fields,
  });
  fs.appendFileSync(logFile, `${line}\n`, 'utf8');
  process.stdout.write(`${line}\n`);
}

function stripHopByHopHeaders(headers) {
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    const lower = key.toLowerCase();
    if (
      lower === 'proxy-connection' ||
      lower === 'proxy-authorization' ||
      lower === 'connection' ||
      lower === 'keep-alive' ||
      lower === 'te' ||
      lower === 'trailer' ||
      lower === 'transfer-encoding' ||
      lower === 'upgrade'
    ) {
      delete next[key];
    }
  }
  return next;
}

const server = http.createServer((req, res) => {
  let target;
  try {
    target = new URL(req.url);
  } catch (error) {
    log('http_invalid_url', { url: req.url, error: String(error) });
    res.writeHead(400);
    res.end('Bad proxy request');
    return;
  }

  log('http_request', {
    method: req.method,
    url: req.url,
    host: target.host,
    headers: req.headers,
  });

  const upstreamReq = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: stripHopByHopHeaders(req.headers),
    },
    (upstreamRes) => {
      log('http_response', {
        method: req.method,
        url: req.url,
        statusCode: upstreamRes.statusCode,
        headers: upstreamRes.headers,
      });
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on('error', (error) => {
    log('http_error', { method: req.method, url: req.url, error: error.message });
    if (!res.headersSent) res.writeHead(502);
    res.end('Proxy upstream error');
  });

  req.pipe(upstreamReq);
});

server.on('connect', (req, clientSocket, head) => {
  const [hostname, rawPort] = (req.url || '').split(':');
  const targetPort = Number(rawPort || 443);

  log('connect_request', {
    url: req.url,
    hostname,
    port: targetPort,
    headers: req.headers,
  });

  const upstreamSocket = net.connect(targetPort, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', (error) => {
    log('connect_error', { url: req.url, error: error.message });
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.destroy();
  });

  clientSocket.on('error', (error) => {
    log('client_socket_error', { url: req.url, error: error.message });
    upstreamSocket.destroy();
  });

  upstreamSocket.on('close', () => {
    log('connect_closed', { url: req.url });
  });
});

server.on('clientError', (error, socket) => {
  log('client_error', { error: error.message });
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(port, host, () => {
  log('proxy_listening', { host, port, logFile });
});
