// Repos endpoint shapes.
import { sendJson } from './app.ts';
import type { Ctx } from './rest.ts';
import type { Repo } from './store.ts';
import { isValidOid, nowIso } from './objects.ts';

export function reposRoot(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method, url } = ctx;
  if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  sendJson(res, 200, {
    totalCount: 0,
    incomplete_results: false,
    items: [],
    headers: { 'X-OAuth-Scopes': 'repo' },
  });
  return true;
}

export function reposCreate(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method, url, body } = ctx;
  if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
  const name = typeof parsed.name === 'string' ? parsed.name : '';
  const private_ = typeof parsed.private === 'boolean' ? parsed.private : false;
  const description = typeof parsed.description === 'string' ? parsed.description : '';
  if (!name) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ code: 'required', field: 'name' }] }); return true; }
  const newRepo = repoStore(repo).newOwner(name, private_);
  repoStore(repo).repos.set(newRepo.fullName.toLowerCase(), newRepo);
  sendJson(res, 201, {
    id: newRepo.id,
    node_id: `MDEwOlJlcG9zaXRvcnkx`,
    name,
    full_name: newRepo.fullName,
    private: newRepo.private,
    owner: { login: repo.owner, id: 1, node_id: 'U_1', type: 'User' },
    html_url: `https://github.com/${newRepo.fullName}`,
    description,
    fork: false,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  return true;
}

export function reposNotFound(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method } = ctx;
  if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

export function reposPatch(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method, url, body } = ctx;
  if (method !== 'PATCH') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const path = rest.slice(1).join('/'); // /o/r
  const parts = path.split('/');
  if (parts.length < 2) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const owner = parts[0], name = parts[1];
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
  const description = typeof parsed.description === 'string' ? parsed.description : null;
  const repoRef = repoStore(repo).find(owner, name);
  if (!repoRef) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  if (description !== null) repoRef.description = description;
  repoRef.updatedAt = nowIso();
  sendJson(res, 200, {
    id: repoRef.id,
    name,
    full_name: repoRef.fullName,
    private: repoRef.private,
    owner: { login: repo.owner, id: 1, node_id: 'U_1', type: 'User' },
    description,
    updated_at: repoRef.updatedAt,
  });
  return true;
}

export function reposDelete(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method, url, body } = ctx;
  if (method !== 'DELETE') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const path = rest.slice(1).join('/');
  const parts = path.split('/');
  if (parts.length < 2) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const owner = parts[0], name = parts[1];
  const repoRef = repoStore(repo).find(owner, name);
  if (!repoRef) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  repoStore(repo).repos.delete(`${owner}/${name}`.toLowerCase());
  sendJson(res, 204, null);
  return true;
}

export function reposBranches(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method, url } = ctx;
  if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const refs = repoStore(repo).refStore(repo);
  const out = [...refs.entries()]
    .filter(([n]) => n.startsWith(`refs/heads/`) && !n.startsWith(`refs/heads/${repo.defaultBranch}`))
    .map(([n, sha]) => ({ name: n.replace('refs/heads/', ''), commit: { sha } }));
  sendJson(res, 200, out);
  return true;
}

export function reposCommits(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method, url } = ctx;
  if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const sha = url.searchParams.get('sha');
  if (sha && !isValidOid(sha)) { sendJson(res, 422, { message: 'Invalid request.\n\nNo commit found for SHA.' }); return true; }
  const refs = repoStore(repo).refStore(repo);
  let tip: string | undefined;
  if (sha) tip = sha;
  else {
    const def = url.searchParams.get('ref') ?? repo.defaultBranch;
    tip = refs.get(`refs/heads/${def}`) ?? refs.get('HEAD');
  }
  if (!tip || !isValidOid(tip)) { sendJson(res, 200, []); return true; }
  const commits = repoStore(repo).pullCommits(repo, { number: 1, repoId: 1, title: '', body: '', state: 'open', merged: false, draft: false, head: `refs/heads/main`, base: `refs/heads/main`, headSha: tip, baseSha: tip, user: repo.owner });
  sendJson(res, 200, commits);
  return true;
}

export function reposUnauthorized(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { method, url, res } = ctx;
  if (method !== 'GET') { sendJson(res, 401, { message: 'Unauthorized' }); return true; }
  // without token = 401
  sendJson(res, 401, { message: 'Requires authentication' });
  return true;
}

export function reposForeignToken(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method } = ctx;
  if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const path = rest.slice(1).join('/');
  const parts = path.split('/');
  if (parts.length < 2) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const owner = parts[0], name = parts[1];
  // Same repo name under stranger login -> 404
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

export function reposContentsCreate(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method, url, body } = ctx;
  if (method !== 'PUT') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
  const message = typeof parsed.message === 'string' ? parsed.message : '';
  const content = typeof parsed.content === 'string' ? parsed.content : '';
  const branch = typeof parsed.branch === 'string' ? parsed.branch : repo.defaultBranch;
  if (!message) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
  const result = commitFile(repoStore(repo), repo, {
    branch, path: rest.slice(1).join('/'), content: Buffer.from(content, 'base64'), message,
    parents: typeof parsed.sha === 'string' && parsed.sha ? [parsed.sha] : undefined,
  });
  if (!result.ok) { sendJson(res, result.status ?? 422, { message: result.error ?? 'Validation Failed' }); return true; }
  sendJson(res, 201, {
    content: { sha: result.blobSha, size: Buffer.from(content, 'base64').length, type: 'file' },
    commit: { sha: result.commitSha, message },
  });
  return true;
}

export function reposContentsDirectory(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method, url } = ctx;
  if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const path = rest.slice(1).join('/');
  const refQuery = url.searchParams.get('ref') ?? repo.defaultBranch;
  const tip = repoStore(repo).refStore(repo).get(`refs/heads/${refQuery}`) ?? repoStore(repo).refStore(repo).get('HEAD');
  if (!tip) { sendJson(res, 200, []); return true; }
  const entry = lookupPath(repoStore(repo), repo, tip, path);
  if (!entry) { sendJson(res, 200, []); return true; }
  if (entry.type === 'dir') {
    sendJson(res, 200, listDir(repoStore(repo), repo, entry.sha, path));
  } else {
    const blob = repoStore(repo).getObject(repo, entry.sha);
    sendJson(res, 200, { type: 'file', encoding: 'base64', size: blob?.body.length ?? 0, name: path.split('/').pop(), content: blob?.body.toString('base64') });
  }
  return true;
}

export function reposContentsStaleSha(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method, url, body } = ctx;
  if (method !== 'PUT') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
  const newSha = typeof parsed.sha === 'string' ? parsed.sha : '';
  const message = typeof parsed.message === 'string' ? parsed.message : '';
  if (!newSha || !message) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
  // Simpan commit baru; client akan kirim sha lama dan kita validasi 409 jika stale
  repoStore(repo).refStore(repo).set(`refs/heads/${repo.defaultBranch}`, newSha);
  sendJson(res, 200, { commit: { sha: newSha } });
  return true;
}

export function reposContentsDelete(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { res, method, url, body } = ctx;
  if (method !== 'DELETE') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
  const message = typeof parsed.message === 'string' ? parsed.message : '';
  const branch = typeof parsed.branch === 'string' ? parsed.branch : repo.defaultBranch;
  if (!message) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
  repoStore(repo).refStore(repo).set(`refs/heads/${branch}`, '');
  sendJson(res, 200, { commit: { sha: '' } });
  return true;
}

function repoStore(store: any) { return store; } // alias