// REST v3 router: repos, issues, pulls, protocol behaviours.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readBody } from './app.ts';
import type { Store, Repo } from './store.ts';
import { labelObj, knownLabel, nowIso } from './store.ts';
import { serializeRepo } from './serialize.ts';
import { restIssues } from './rest-issues.ts';
import { restPulls } from './rest-pulls.ts';

export interface Ctx {
  store: Store;
  token: string | null;
  method: string;
  path: string;
  url: URL;
  body: Buffer;
  req: IncomingMessage;
  res: ServerResponse;
}

const PER_PAGE_DEFAULT = 30;
const PER_PAGE_MAX = 100;

export function paginate<T>(items: T[], url: URL): { page: T[]; headers: Record<string, string> } {
  const rawPer = Number(url.searchParams.get('per_page') ?? PER_PAGE_DEFAULT);
  const perPage = Math.min(PER_PAGE_MAX, Math.max(1, Number.isFinite(rawPer) ? rawPer : PER_PAGE_DEFAULT));
  const rawPage = Number(url.searchParams.get('page') ?? 1);
  const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1);
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);

  const links: string[] = [];
  const mk = (p: number, rel: string) => {
    const u = new URL(url.toString());
    u.searchParams.set('page', String(p));
    u.searchParams.set('per_page', String(perPage));
    return `<http://${u.host}${u.pathname}${u.search}>; rel="${rel}"`;
  };
  links.push(mk(page, 'self'));
  if (page > 1) links.push(mk(page - 1, 'prev'), mk(1, 'first'));
  if (page < lastPage) links.push(mk(page + 1, 'next'), mk(lastPage, 'last'));

  return { page: slice, headers: { link: links.join(', ') } };
}

function parseJson(body: Buffer): Record<string, unknown> | null {
  const text = body.toString('utf8').trim();
  if (text === '') return {};
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function restRoutes(ctx: Ctx): Promise<boolean> {
  const { store, method, path, url, res, body } = ctx;

  const parts = path.replace(/^\/api\/v3\/?/, '').split('/').filter((p) => p.length > 0);
  if (!path.startsWith('/api/v3')) return false;

  // ---- /user ----
  if (parts[0] === 'user') {
    if (parts.length === 1 && method === 'GET') {
      sendJson(res, 200, {
        login: store.login,
        id: 1,
        node_id: 'U_1',
        avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
        type: 'User',
        name: store.login,
        public_repos: store.repos.size,
        followers: 0,
        following: 0,
        created_at: '2020-01-01T00:00:00Z',
      });
      return true;
    }
    if (parts[1] === 'repos' && parts.length === 2) {
      if (method === 'GET') {
        const mine = [...store.repos.values()].filter((r) => r.owner === store.login);
        const { page, headers } = paginate(mine, url);
        sendJson(res, 200, page.map((r) => serializeRepo(r, store)), headers);
        return true;
      }
      if (method === 'POST') {
        const parsed = parseJson(body);
        if (!parsed) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
        const name = typeof parsed.name === 'string' ? parsed.name : '';
        if (name === '') { sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] }); return true; }
        const existing = store.find(store.login, name);
        if (existing) {
          sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] });
          return true;
        }
        const repo = store.newRepo(store.login, name, {
          description: typeof parsed.description === 'string' ? parsed.description : null,
          private: parsed.private === true,
          visibility: parsed.private === true ? 'private' : 'public',
          defaultBranch: typeof parsed.default_branch === 'string' ? parsed.default_branch : 'main',
          homepage: typeof parsed.homepage === 'string' ? parsed.homepage : null,
          isTemplate: parsed.is_template === true,
          hasIssues: parsed.has_issues !== false,
          hasWiki: parsed.has_wiki !== false,
          hasProjects: parsed.has_projects !== false,
          hasDownloads: parsed.has_downloads !== false,
          topics: Array.isArray(parsed.topics) ? (parsed.topics as string[]) : [],
        });
        sendJson(res, 201, serializeRepo(repo, store));
        return true;
      }
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (parts[0] !== 'repos') {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // ---- /repos (list all) ----
  if (parts.length === 1 && method === 'GET') {
    const all = [...store.repos.values()];
    const { page, headers } = paginate(all, url);
    sendJson(res, 200, page.map((r) => serializeRepo(r, store)), headers);
    return true;
  }

  // ---- /repos/:owner/:repo ----
  const owner = parts[1];
  const name = parts[2];
  if (!owner || !name) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const repo = store.find(owner, name);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }

  const rest = parts.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, serializeRepo(repo, store)); return true; }
    if (method === 'PATCH') {
      const parsed = parseJson(body);
      if (!parsed) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
      if (typeof parsed.name === 'string' && parsed.name !== repo.name) {
        store.repos.delete(repo.fullName.toLowerCase());
        repo.name = parsed.name;
        repo.fullName = `${repo.owner}/${parsed.name}`;
        store.repos.set(repo.fullName.toLowerCase(), repo);
      }
      if (typeof parsed.description === 'string') repo.description = parsed.description;
      else if (parsed.description === null) repo.description = null;
      if (typeof parsed.homepage === 'string') repo.homepage = parsed.homepage;
      if (typeof parsed.private === 'boolean') { repo.private = parsed.private; repo.visibility = parsed.private ? 'private' : 'public'; }
      if (typeof parsed.default_branch === 'string') repo.defaultBranch = parsed.default_branch;
      if (typeof parsed.archived === 'boolean') repo.archived = parsed.archived;
      if (typeof parsed.is_template === 'boolean') repo.isTemplate = parsed.is_template;
      if (Array.isArray(parsed.topics)) repo.topics = parsed.topics as string[];
      repo.updatedAt = nowIso();
      sendJson(res, 200, serializeRepo(repo, store));
      return true;
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.fullName.toLowerCase());
      res.writeHead(204);
      res.end();
      return true;
    }
  }

  if (rest[0] === 'branches' && method === 'GET') {
    const refs = store.refStore(repo);
    const out: unknown[] = [];
    for (const [refName, sha] of refs) {
      if (!refName.startsWith('refs/heads/')) continue;
      const branch = refName.slice('refs/heads/'.length);
      if (rest.length === 2 && rest[1] !== branch) continue;
      out.push({
        name: branch,
        commit: { sha, url: `/api/v3/repos/${repo.fullName}/commits/${sha}` },
        protected: false,
      });
    }
    if (rest.length === 2) {
      if (out.length === 0) { sendJson(res, 404, { message: 'Branch not found' }); return true; }
      sendJson(res, 200, out[0]);
      return true;
    }
    sendJson(res, 200, out);
    return true;
  }

  if (rest[0] === 'commits' && method === 'GET') {
    const { commitsList } = await import('./rest-commits.ts');
    return commitsList(ctx, repo, rest);
  }

  if (rest[0] === 'contents') {
    const { contents } = await import('./rest-contents.ts');
    return contents(ctx, repo, rest);
  }

  if (rest[0] === 'issues') {
    return restIssues(ctx, repo, rest);
  }

  if (rest[0] === 'pulls') {
    return restPulls(ctx, repo, rest);
  }

  if (rest[0] === 'labels' && method === 'GET') {
    const names = ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted', 'wontfix', 'duplicate'];
    sendJson(res, 200, names.map(labelObj));
    return true;
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

export { parseJson, PER_PAGE_DEFAULT, PER_PAGE_MAX, knownLabel };
export type { Repo };
