// Contents API: read a path at a ref, create/update/delete files.
import { sendJson } from './app.ts';
import type { Ctx } from './rest.ts';
import type { Repo } from './store.ts';
import { parseCommitBody, parseTreeBody, buildTreeBody, buildCommitBody, isValidOid } from './objects.ts';

export function contentsRoute(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { store, res, method, url, body } = ctx;
  const refQuery = url.searchParams.get('ref') ?? '';
  const pathParam = rest.slice(1).join('/');

  const refs = store.refStore(repo);
  const resolveRef = (ref: string): string | null => {
    if (!ref) return refs.get('HEAD') ?? refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    return refs.get(`refs/heads/${ref}`) ?? refs.get(`refs/tags/${ref}`) ?? (isValidOid(ref) ? ref : null);
  };

  if (method === 'GET' || method === 'HEAD') {
    const tip = resolveRef(refQuery);
    if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    const entry = lookupPath(store, repo, tip, pathParam);
    if (!entry) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    if (entry.type === 'dir') {
      sendJson(res, 200, listDir(store, repo, entry.sha, pathParam));
      return true;
    }
    const blob = store.getObject(repo, entry.sha);
    if (!blob) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.body.length,
      name: pathParam.split('/').pop(),
      path: pathParam,
      content: blob.body.toString('base64').replace(/(.{60})/g, '$1\n').trimEnd(),
      sha: entry.sha,
      url: `/api/v3/repos/${repo.fullName}/contents/${pathParam}`,
      git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${entry.sha}`,
      html_url: `https://github.com/${repo.fullName}/blob/${refQuery || repo.defaultBranch}/${pathParam}`,
      download_url: null,
      _links: { self: `/api/v3/repos/${repo.fullName}/contents/${pathParam}`, git: '', html: '' },
    });
    return true;
  }

  if (method === 'PUT') {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
    const message = typeof parsed.message === 'string' ? parsed.message : '';
    const rawContent = typeof parsed.content === 'string' ? parsed.content : '';
    const branch = typeof parsed.branch === 'string' ? parsed.branch : repo.defaultBranch;
    if (!message) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Commit', field: 'message', code: 'missing' }] }); return true; }
    let data: Buffer;
    try {
      data = parsed.encoding === 'utf-8' || parsed.encoding === 'utf8' ? Buffer.from(rawContent, 'utf8') : Buffer.from(rawContent.replace(/\s/g, ''), 'base64');
    } catch { sendJson(res, 422, { message: 'Validation Failed', errors: [{ code: 'invalid' }] }); return true; }

    const result = commitFile(store, repo, {
      branch,
      path: pathParam,
      content: data,
      message,
      parents: typeof parsed.sha === 'string' && parsed.sha ? [parsed.sha] : undefined,
    });
    if (!result.ok) { sendJson(res, result.status ?? 422, { message: result.error ?? 'Validation Failed' }); return true; }
    sendJson(res, 200, {
      content: { name: pathParam.split('/').pop(), path: pathParam, sha: result.blobSha, size: data.length, type: 'file' },
      commit: { sha: result.commitSha, message, tree: { sha: result.treeSha } },
    });
    return true;
  }

  if (method === 'DELETE') {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
    const message = typeof parsed.message === 'string' ? parsed.message : '';
    const branch = typeof parsed.branch === 'string' ? parsed.branch : repo.defaultBranch;
    if (!message) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
    const result = commitFile(store, repo, { branch, path: pathParam, content: null, message, parents: typeof parsed.sha === 'string' && parsed.sha ? [parsed.sha] : undefined });
    if (!result.ok) { sendJson(res, result.status ?? 422, { message: result.error ?? 'Validation Failed' }); return true; }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ content: null, commit: { sha: result.commitSha, message, tree: { sha: result.treeSha } } }));
    return true;
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

function lookupPath(store: Ctx['store'], repo: Repo, tip: string, path: string): { type: 'file' | 'dir'; sha: string } | null {
  const obj = store.getObject(repo, tip);
  if (!obj) return null;
  let treeSha = tip;
  if (obj.type === 'commit') treeSha = parseCommitBody(obj.body).tree;
  if (!path) {
    const t = store.getObject(repo, treeSha);
    if (!t) return null;
    return { type: 'dir', sha: treeSha };
  }
  const parts = path.split('/').filter(Boolean);
  let cur = treeSha;
  for (let i = 0; i < parts.length; i++) {
    const t = store.getObject(repo, cur);
    if (!t || t.type !== 'tree') return null;
    const e = parseTreeBody(t.body).find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return { type: e.mode === '40000' ? 'dir' : 'file', sha: e.sha };
    cur = e.sha;
  }
  return null;
}

function listDir(store: Ctx['store'], repo: Repo, treeSha: string, prefix: string) {
  const t = store.getObject(repo, treeSha);
  if (!t) return [];
  return parseTreeBody(t.body).map((e) => {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    const isDir = e.mode === '40000';
    return {
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : store.getObject(repo, e.sha)?.body.length ?? 0,
      name: e.name,
      path,
      sha: e.sha,
      url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
      git_url: `/api/v3/repos/${repo.fullName}/git/${isDir ? 'trees' : 'blobs'}/${e.sha}`,
      html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
      download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/${path}`,
      _links: { self: `/api/v3/repos/${repo.fullName}/contents/${path}`, git: '', html: '' },
    };
  });
}

export function commitFile(
  store: Ctx['store'],
  repo: Repo,
  opts: { branch: string; path: string; content: Buffer | null; message: string; parents?: string[] | undefined },
): { ok: boolean; commitSha?: string; treeSha?: string; blobSha?: string; error?: string; status?: number } {
  const refs = store.refStore(repo);
  const refName = `refs/heads/${opts.branch}`;
  const parentSha = opts.parents?.[0] ?? refs.get(refName) ?? null;
  let baseTreeSha: string | null = null;
  let parents: string[] = [];
  const ts = Math.floor(Date.now() / 1000);
  let author = `golden-wren-79 <golden-wren-79@users.noreply.github.com> ${ts} +0000`;
  let committer = author;

  if (parentSha) {
    const pObj = store.getObject(repo, parentSha);
    if (!pObj || pObj.type !== 'commit') return { ok: false, error: 'Branch not found', status: 404 };
    const pc = parseCommitBody(pObj.body);
    baseTreeSha = pc.tree;
    parents = [parentSha];
    author = pc.author;
    committer = pc.committer;
  }

  const parts = opts.path.split('/').filter(Boolean);
  if (parts.length === 0) return { ok: false, error: 'path required', status: 422 };

  let newBlobSha: string | null = null;
  if (opts.content) newBlobSha = store.putObject(repo, 'blob', opts.content);

  const mkTree = (treeSha: string | null, idx: number): string => {
    const entries = treeSha ? [...parseTreeBody(store.getObject(repo, treeSha)?.body ?? Buffer.alloc(0))] : [];
    const name = parts[idx]!;
    const isLeaf = idx === parts.length - 1;
    const pos = entries.findIndex((e) => e.name === name);
    if (isLeaf) {
      if (newBlobSha === null) {
        if (pos >= 0) entries.splice(pos, 1);
      } else if (pos >= 0) entries[pos] = { mode: '100644', name, sha: newBlobSha };
      else entries.push({ mode: '100644', name, sha: newBlobSha });
    } else {
      let subSha: string | null = null;
      if (pos >= 0 && entries[pos]!.mode === '40000') subSha = entries[pos]!.sha;
      const childSha = mkTree(subSha, idx + 1);
      if (pos >= 0) entries[pos] = { mode: '40000', name, sha: childSha };
      else entries.push({ mode: '40000', name, sha: childSha });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return store.putObject(repo, 'tree', buildTreeBody(entries));
  };

  const treeSha = mkTree(baseTreeSha, 0);
  const commitBody = buildCommitBody({ tree: treeSha, parents, author, committer, message: opts.message });
  const commitSha = store.putObject(repo, 'commit', commitBody);
  refs.set(refName, commitSha);
  if (opts.branch === repo.defaultBranch) refs.set('HEAD', commitSha);
  repo.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { ok: true, commitSha, treeSha, blobSha: newBlobSha ?? undefined };
}
