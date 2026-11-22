import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { describe, expect, it } from 'vitest';

import { CertificateAuthority } from '../src/warp/ca.js';
import { createWarpHandlers } from '../src/warp/connect.js';
import { defaultRoutes } from '../src/warp/index.js';

function httpsViaConnect(proxyPort: number, host: string, path: string, caPem: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `${host}:443` });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT failed with ${res.statusCode}`));
        return;
      }
      const tlsSocket = tlsConnect({ socket, servername: host, ca: caPem });
      const inner = httpsRequest(
        { host, port: 443, path, method: 'GET', createConnection: () => tlsSocket },
        (innerRes) => {
          let body = '';
          innerRes.setEncoding('utf8');
          innerRes.on('data', (chunk) => (body += chunk));
          innerRes.on('end', () => resolve({ status: innerRes.statusCode ?? 0, body }));
        },
      );
      inner.on('error', reject);
      inner.end();
    });
    req.on('error', reject);
    req.end();
  });
}

describe('CONNECT proxy and warp integration', () => {
  it('diverts matching HTTPS requests (Anthropic + CloudCode PA) to the local handler over CONNECT', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pxpipe-test-ca-'));
    const ca = CertificateAuthority.loadOrCreate(tmpDir);
    let divertCount = 0;

    const testServer = createServer();
    const port = await new Promise<number>((resolve) => {
      testServer.listen(0, '127.0.0.1', () => {
        const addr = testServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    const routes = defaultRoutes(port);
    const warpHandlers = createWarpHandlers({
      routes,
      ca,
      onDivert: () => {
        divertCount++;
      },
    });

    testServer.on('request', (req, res) => {
      if (req.url && (req.url.startsWith('http://') || req.url.startsWith('https://'))) {
        warpHandlers.handleAbsoluteForm(req, res);
        return;
      }
      if (req.url?.startsWith('/v1/messages') || req.url?.startsWith('/v1internal:streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, diverted: true, path: req.url }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    testServer.on('connect', warpHandlers.handleConnect);

    try {
      const caPem = readFileSync(ca.certPath, 'utf8');
      const anthropic = await httpsViaConnect(port, 'api.anthropic.com', '/v1/messages', caPem);
      expect(anthropic.status).toBe(200);
      expect(anthropic.body).toContain('"diverted":true');

      const cloudcode = await httpsViaConnect(port, 'cloudcode-pa.googleapis.com', '/v1internal:streamGenerateContent', caPem);
      expect(cloudcode.status).toBe(200);
      expect(cloudcode.body).toContain('"diverted":true');

      expect(divertCount).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
