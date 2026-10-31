// Shared test helpers for the HTTP tests: a real node:http server on 127.0.0.1 and a raw client
// that sends the path exactly as given (fetch would normalize `..` away).

import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Served = { port: number; base: string; close: () => Promise<void> };

export async function serve(listener: (req: IncomingMessage, res: ServerResponse) => void): Promise<Served> {
  const server = createServer(listener);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export type RawResponse = { status: number; headers: IncomingHttpHeaders; body: string };

export function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
