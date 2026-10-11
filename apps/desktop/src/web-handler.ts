// Serves the Expo web export for app://heyda/. Pure Node (no Electron import) so it is unit-tested.
import { readFile as readFileCallback } from 'node:fs';
import path from 'node:path';
import { CONTENT_SECURITY_POLICY, isAppUrl, mimeTypeFor, resolveWebPath } from './security';

export type ReadFile = (file: string) => Promise<Buffer>;

// The callback API is what Electron's asar support patches most reliably, so use it for files inside app.asar.
const readFromDisk: ReadFile = (file) =>
  new Promise((resolve, reject) => readFileCallback(file, (error, data) => (error ? reject(error) : resolve(data))));

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache',
};

export function createWebHandler(root: string, readFile: ReadFile = readFromDisk): (request: Request) => Promise<Response> {
  const indexFile = path.join(root, 'index.html');
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'Method not allowed');
    if (!isAppUrl(request.url)) return textResponse(404, 'Not found');

    const target = resolveWebPath(root, new URL(request.url).pathname);
    if (target.kind === 'invalid') return textResponse(400, 'Bad request');
    const file = target.kind === 'file' ? target.path : indexFile;

    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      return file === indexFile
        ? textResponse(500, 'Heyda. UI is missing. Run "npm run prepare-web -w desktop" before building.')
        : textResponse(404, 'Not found');
    }
    const headers = { ...SECURITY_HEADERS, 'Content-Type': mimeTypeFor(file) ?? 'application/octet-stream' };
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), { status: 200, headers });
  };
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
}
