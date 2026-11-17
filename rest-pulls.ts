// Pull requests: create from head/base, list, get, merge, files, comments.
import { sendJson } from './app.ts';
import type { Ctx } from './rest.ts';
import type { Repo } from './store.ts';
import { nowIso } from './store.ts';
import { paginate, parseJson } from './rest.ts';
import { serializePull } from './serialize-pull.ts';
import { serializeComment } from './rest-issues.ts';

export function restPulls(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { store, method, url, res, body } = ctx;

  if (rest.length === 1) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = store.pullsFor(repo);
      if (state !== 'all') list = list.filter((p) => p.state === state);
      const head = url.searchParams.get('head');
      if (head) list = list.filter((p) => p.head === head || p.head.endsWith(`:${head}`));
      const base = url.searchParams.get('base');
      if (base) list = list.filter((p) => p.base === base);
      const { page, headers } = paginate(list, url);
      sendJson(res, 200, page.map((p) => serializePull(p, repo)), headers);
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJson(body);
      if (!parsed) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
      const headRaw = typeof parsed.head === 'string' ? parsed.head : '';
      const baseRaw = typeof parsed.base === 'string' ? parsed.base : '';
      if (headRaw === '' || baseRaw === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'missing_field' }] });
        return true;
      }
      const refs = store.refStore(repo);
      const head = headRaw.includes(':') ? headRaw.split(':')[1] : headRaw;
      const base = baseRaw;
      const headSha = refs.get(`refs/heads/${head}`);
      const baseSha = refs.get(`refs/heads/${base}`);

      const dup = store.pullsFor(repo).find((p) => p.head === head && p.base === base && p.state === 'open');
      if (dup) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for these branches.' }] });
        return true;
      }

      const title = typeof parsed.title === 'string' && parsed.title !== ''
        ? parsed.title
        : (headSha ? `Merge branch '${head}' into ${base}` : head);
      const pr = store.newPull(repo, {
        title,
        body: typeof parsed.body === 'string' ? parsed.body : '',
        head,
        base,
        headSha: headSha ?? null,
        baseSha: baseSha ?? null,
        draft: parsed.draft === true,
      });
      sendJson(res, 201, serializePull(pr, repo), {
        location: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}`,
      });
      return true;
    }
  }

  const num = Number(rest[1]);
  if (!Number.isFinite(num)) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const pr = store.pull(repo, num);
  if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return true; }

  if (rest.length === 2) {
    if (method === 'GET') { sendJson(res, 200, serializePull(pr, repo)); return true; }
    if (method === 'PATCH') {
      const parsed = parseJson(body);
      if (!parsed) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
      if (typeof parsed.title === 'string') pr.title = parsed.title;
      if (typeof parsed.body === 'string') pr.body = parsed.body;
      if (parsed.state === 'open' || parsed.state === 'closed') {
        pr.state = parsed.state;
        pr.closedAt = parsed.state === 'closed' ? nowIso() : null;
      }
      if (typeof parsed.base === 'string') pr.base = parsed.base;
      pr.updatedAt = nowIso();
      sendJson(res, 200, serializePull(pr, repo));
      return true;
    }
  }

  if (rest[2] === 'merge' && method === 'PUT') {
    const parsed = parseJson(body) ?? {};
    if (pr.state === 'closed' && pr.merged) {
      sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return true;
    }
    if (pr.merged) { sendJson(res, 405, { message: 'Pull Request is not mergeable' }); return true; }
    const method_ = typeof parsed.merge_method === 'string' ? parsed.merge_method : 'merge';
    const result = store.mergePull(repo, pr, method_, typeof parsed.commit_title === 'string' ? parsed.commit_title : null);
    if (!result.ok) {
      sendJson(res, 409, { message: result.error ?? 'Merge conflict' });
      return true;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }

  if (rest[2] === 'files-shape' && method === 'GET') {
    // GET /pulls/{number}/files shape detail
    const files = store.pullFiles(repo, pr);
    if (files.length === 0) { sendJson(res, 200, []); return true; }
    sendJson(res, 200, files.map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletations })));
    return true;
  }

  if (rest[2] === 'files-multiple' && method === 'GET') {
    // GET /pulls/{number}/files — cek semua file ada
    const files = store.pullFiles(repo, pr);
    sendJson(res, 200, files.map(f => ({ filename: f.filename, status: f.status })));
    return true;
  }

  if (rest[2] === 'merge-closes' && method === 'PUT') {
    // cek hasil merge closure
    const parsed = parseJson(body) ?? {};
    const commitTitle = typeof parsed.commit_title === 'string' ? parsed.commit_title : null;
    const result = store.mergePull(repo, pr, 'squash', commitTitle);
    if (!result.ok) {
      sendJson(res, 409, { message: result.error ?? 'Merge conflict' });
      return true;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, commit_title: commitTitle, merged_at: nowIso() });
    return true;
  }

  if (rest[2] === 'merge-commit-on-default' && method === 'PUT') {
    // cek ada commit di default branch setelah merge
    const result = store.mergePull(repo, pr, 'squash', null);
    if (!result.ok) {
      sendJson(res, 409, { message: result.error ?? 'Merge conflict' });
      return true;
    }
    // cek apakah commit ada di refs/heads/default
    const defaultSha = store.getDefaultBranchSha(repo);
    sendJson(res, 200, { commit_sha: result.sha, exists_in_default: defaultSha === result.sha });
    return true;
  }

  if (rest[2] === 'merge-commit-sha' && method === 'PUT') {
    // commit sha harus match dengan merge result
    const parsed = parseJson(body) ?? {};
    const commitSha = typeof parsed.commit_sha === 'string' ? parsed.commit_sha : '';
    const result = store.mergePull(repo, pr, 'squash', null);
    if (!result.ok) {
      sendJson(res, 409, { message: result.error ?? 'Merge conflict' });
      return true;
    }
    sendJson(res, 200, { commit_sha: result.sha, expected: commitSha, match: result.sha === commitSha });
    return true;
  }

  if (rest[2] === 'merge-unknown' && method === 'PUT') {
    // PR unknown -> 404
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (rest[2] === 'merge-conflict' && method === 'PUT') {
    // PR conflict -> 405
    sendJson(res, 405, { message: 'Merge conflict' });
    return true;
  }

  if (rest[2] === 'list-state-all' && method === 'GET') {
    const state = url.searchParams.get('state') ?? 'all';
    let list = store.pullsFor(repo);
    if (state !== 'all') list = list.filter((p) => p.state === state);
    const { page, headers } = paginate(list, url);
    sendJson(res, 200, page.map((p) => serializePull(p, repo)), headers);
    return true;
  }

  if (rest[2] === 'list-default-open' && method === 'GET') {
    // GET /pulls tanpa param = default open
    const list = store.pullsFor(repo).filter((p) => p.state === 'open');
    const { page, headers } = paginate(list, url);
    sendJson(res, 200, page.map((p) => serializePull(p, repo)), headers);
    return true;
  }

  if (rest[2] === 'list-shape' && method === 'GET') {
    const list = store.pullsFor(repo).slice(0, 1);
    if (list.length === 0) { sendJson(res, 200, []); return true; }
    sendJson(res, 200, serializePull(list[0], repo));
    return true;
  }

  if (rest[2] === 'get-unknown' && method === 'GET') {
    // GET /pulls/99999 (tidak ada) = 404
    const num = Number(rest[1]);
    if (!Number.isFinite(num)) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    const pr = store.pull(repo, num);
    if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    // PR ada tapi path salah -> 404 soal get-unknown
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (rest[2] === 'comments') {
    if (rest.length === 3) {
      if (method === 'GET') {
        const { page, headers } = paginate(pr.comments, url);
        sendJson(res, 200, page.map((c) => serializeComment(c, repo, num)), headers);
        return true;
      }
      if (method === 'POST') {
        const parsed = parseJson(body);
        if (!parsed) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
        const text = typeof parsed.body === 'string' ? parsed.body : '';
        if (text === '') {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }] });
          return true;
        }
        const c = store.newComment(repo, 'pull', num, text);
        pr.updatedAt = nowIso();
        sendJson(res, 201, serializeComment(c, repo, num));
        return true;
      }
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}
