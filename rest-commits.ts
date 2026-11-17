// Git data + commit listing REST endpoints.
import { sendJson } from './app.ts';
import type { Ctx } from './rest.ts';
import type { Repo } from './store.ts';
import { parseCommitBody, parseTreeBody, isValidOid } from './objects.ts';
import { paginate } from './rest.ts';

export function serializeCommit(sha: string, body: Buffer, repo: Repo) {
  const c = parseCommitBody(body);
  return {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    commit: {
      author: c.author,
      committer: c.committer,
      message: c.message,
      tree: { sha: c.tree, url: `/api/v3/repos/${repo.fullName}/git/trees/${c.tree}` },
      url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
    comments_url: `/api/v3/repos/${repo.fullName}/commits/${sha}/comments`,
    author: { login: repo.owner, id: 1, type: 'User' },
    committer: { login: repo.owner, id: 1, type: 'User' },
    parents: c.parents.map((p) => ({
      sha: p,
      url: `/api/v3/repos/${repo.fullName}/commits/${p}`,
      html_url: `https://github.com/${repo.fullName}/commit/${p}`,
    })),
  };
}

export function commitsList(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { store, method, url, res } = ctx;

  if (rest.length >= 2) {
    const sha = rest[1];
    if (!isValidOid(sha)) { sendJson(res, 422, { message: 'Invalid request.\n\nNo commit found for SHA.' }); return true; }
    const obj = store.getObject(repo, sha);
    if (!obj || obj.type !== 'commit') { sendJson(res, 404, { message: 'No commit found for SHA: ' + sha }); return true; }
    if (rest[2] === 'comments' && method === 'GET') { sendJson(res, 200, []); return true; }
    sendJson(res, 200, serializeCommit(sha, obj.body, repo));
    return true;
  }

  if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }

  const refs = store.refStore(repo);
  const refParam = url.searchParams.get('sha') ?? repo.defaultBranch;
  let tip = refs.get(`refs/heads/${refParam}`) ?? refs.get(`refs/tags/${refParam}`) ?? refs.get('HEAD') ?? refParam;
  if (!isValidOid(tip)) { sendJson(res, 200, []); return true; }

  const limit = Number(url.searchParams.get('per_page') ?? 30);
  const seen = new Set<string>();
  const out: unknown[] = [];
  let cur: string | null = tip;
  while (cur && !seen.has(cur) && out.length < Math.min(100, Math.max(1, limit))) {
    seen.add(cur);
    const obj = store.getObject(repo, cur);
    if (!obj || obj.type !== 'commit') break;
    out.push(serializeCommit(cur, obj.body, repo));
    cur = parseCommitBody(obj.body).parents[0] ?? null;
  }
  sendJson(res, 200, out);
  return true;
}

export function gitTrees(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { store, res, url } = ctx;
  const sha = rest[1];
  const obj = sha === 'HEAD' ? store.getObject(repo, store.refStore(repo).get('HEAD') ?? '') : store.getObject(repo, sha);
  if (!obj) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  let treeSha = sha;
  let treeObj = obj;
  if (obj.type === 'commit') {
    const c = parseCommitBody(obj.body);
    treeSha = c.tree;
    const t = store.getObject(repo, treeSha);
    if (!t) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    treeObj = t;
  }
  const recursive = url.searchParams.get('recursive') === '1' || url.searchParams.get('recursive') === 'true';
  const tree = parseTreeBody(treeObj.body).map((e) => ({
    path: e.name,
    mode: e.mode,
    type: e.mode === '40000' ? 'tree' : 'blob',
    sha: e.sha,
    size: undefined as number | undefined,
    url: `/api/v3/repos/${repo.fullName}/git/${e.mode === '40000' ? 'trees' : 'blobs'}/${e.sha}`,
  }));
  void recursive;
  sendJson(res, 200, { sha: treeSha, url: `/api/v3/repos/${repo.fullName}/git/trees/${treeSha}`, tree, truncated: false });
  return true;
}

export function gitBlobs(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { store, res } = ctx;
  const sha = rest[1];
  const obj = store.getObject(repo, sha);
  if (!obj || obj.type !== 'blob') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  sendJson(res, 200, {
    sha,
    node_id: `B_${sha.slice(0, 12)}`,
    size: obj.body.length,
    url: `/api/v3/repos/${repo.fullName}/git/blobs/${sha}`,
    content: obj.body.toString('base64').replace(/(.{60})/g, '$1\n').trimEnd(),
    encoding: 'base64',
  });
  return true;
}

export function gitRefs(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { store, res, method, body } = ctx;
  const refs = store.refStore(repo);

  if (rest.length === 1 && method === 'GET') {
    const out = [...refs.entries()]
      .filter(([n]) => n.startsWith('refs/'))
      .map(([n, sha]) => ({ ref: n, node_id: `R_${sha.slice(0, 8)}`, url: `/api/v3/repos/${repo.fullName}/git/${n}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } }));
    sendJson(res, 200, out);
    return true;
  }

  if (rest.length >= 2 && method === 'GET') {
    const name = rest.slice(1).join('/');
    const full = name.startsWith('refs/') ? name : `refs/${name}`;
    const sha = refs.get(full);
    if (!sha) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    sendJson(res, 200, { ref: full, node_id: 'R_1', url: `/api/v3/repos/${repo.fullName}/git/${full}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
    return true;
  }

  if (method === 'POST') {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
    const refName = typeof parsed.ref === 'string' ? parsed.ref : '';
    const sha = typeof parsed.sha === 'string' ? parsed.sha : '';
    if (!refName || !sha) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
    const full = refName.startsWith('refs/') ? refName : `refs/${refName}`;
    if (refs.has(full)) { sendJson(res, 422, { message: 'Reference already exists' }); return true; }
    refs.set(full, sha);
    sendJson(res, 201, { ref: full, node_id: 'R_1', url: `/api/v3/repos/${repo.fullName}/git/${full}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
    return true;
  }

  if (method === 'PATCH' && rest.length >= 2) {
    const name = rest.slice(1).join('/');
    const full = name.startsWith('refs/') ? name : `refs/${name}`;
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
    const sha = typeof parsed.sha === 'string' ? parsed.sha : '';
    const force = parsed.force === true;
    if (!refs.has(full) && !force) { sendJson(res, 422, { message: 'Reference does not exist' }); return true; }
    refs.set(full, sha);
    sendJson(res, 200, { ref: full, node_id: 'R_1', url: `/api/v3/repos/${repo.fullName}/git/${full}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
    return true;
  }

  if (method === 'DELETE' && rest.length >= 2) {
    const name = rest.slice(1).join('/');
    const full = name.startsWith('refs/') ? name : `refs/${name}`;
    refs.delete(full);
    res.writeHead(204);
    res.end();
    return true;
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

export { paginate, serializeTreeEntry };
function serializeTreeEntry(e: { mode: string; name: string; sha: string }) {
  return { path: e.name, mode: e.mode, type: e.mode === '40000' ? 'tree' : 'blob', sha: e.sha };
}
