// HTTP server: git smart HTTP + REST v3 + GraphQL v4 + MCP + health.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, nowIso, randomToken, knownLabel } from './store.ts';
import {
  advertisement, uploadPack, parseUploadPack, receivePack, contentTypes, postContentType,
} from './smarthttp.ts';
import { restRoutes } from './rest.ts';
import { graphql } from './gql.ts';
import { mcp } from './mcp.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-length': body.length, ...headers });
  res.end(body);
}

export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function tokenOf(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('token ')) return auth.slice(6).trim();
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (typeof auth === 'string' && auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      return decoded.slice(decoded.indexOf(':') + 1);
    } catch {
      return null;
    }
  }
  return null;
}

export const BOOT = nowIso();
export const store = new Store('golden-wren-79', randomToken());

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error', detail: msg });
      else res.end();
    });
    // Set X-GitHub-Request-Id header
    res.setHeader('X-GitHub-Request-Id', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = urlOf(req);
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const reqId = req.headers['x-request-id'];
  if (typeof reqId === 'string') res.setHeader('x-request-id', reqId);
  else if (Array.isArray(reqId) && reqId[0]) res.setHeader('x-request-id', reqId[0]);

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- git smart HTTP: /:owner/:repo/{info/refs,git-upload-pack,git-receive-pack} ----
  const gitMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const [, owner, name, action] = gitMatch;
    const repo = store.find(owner, name);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (action === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 403, { message: 'Smart HTTP requires service=git-upload-pack or git-receive-pack' });
        return;
      }
      const body = advertisement(repo, store, service);
      sendRaw(res, 200, body, {
        'content-type': `${contentTypes(service)}\n`,
        'cache-control': 'no-cache',
      });
      return;
    }
    const body = await readBody(req);
    const service = action as 'git-upload-pack' | 'git-receive-pack';
    if (service === 'git-upload-pack') {
      const parsed = parseUploadPack(body);
      const out = uploadPack(repo, store, parsed);
      sendRaw(res, 200, out, { 'content-type': postContentType(service) });
      return;
    }
    const out = receivePack(repo, store, body);
    sendRaw(res, 200, out, { 'content-type': postContentType(service) });
    return;
  }

  const body = await readBody(req);
  const token = tokenOf(req);
  const ctx = { store, token, method, path, url, body, req, res };

  if (path === '/graphql' || path === '/api/graphql') {
    let parsed: { query?: string; variables?: unknown; operationName?: string } = {};
    try {
      parsed = JSON.parse(body.toString('utf8') || '{}');
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const out = graphql(store, parsed.query ?? '', parsed.variables as Record<string, unknown> | undefined);
    sendJson(res, 200, out);
    return;
  }

  if (path === '/mcp' || path === '/api/mcp' || path === '/mcp/v1') {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(body.toString('utf8') || '{}');
    } catch {
      sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const out = await mcp(store, parsed as Record<string, unknown>, req, res);
    if (out !== undefined) sendJson(res, 200, out);
    return;
  }

  if (await restRoutes(ctx)) return;

  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, workflow' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export { readBody, tokenOf, knownLabel };