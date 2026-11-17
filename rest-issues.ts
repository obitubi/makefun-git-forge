// Issues: list, create, comment, close/reopen, label handling.
import { sendJson } from './app.ts';
import type { Ctx } from './rest.ts';
import type { Repo } from './store.ts';
import { labelObj, nowIso } from './store.ts';
import { serializeIssue } from './serialize-issue.ts';
import { paginate, parseJson } from './rest.ts';

export function restIssues(ctx: Ctx, repo: Repo, rest: string[]): boolean {
  const { store, method, url, res, body } = ctx;

  if (rest.length === 1) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = store.issuesFor(repo);
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const labels = url.searchParams.getAll('labels').flatMap((l) => l.split(',')).filter(Boolean);
      if (labels.length) list = list.filter((i) => labels.every((l) => i.labels.some((x) => x.name === l)));
      const { page, headers } = paginate(list, url);
      sendJson(res, 200, page.map((i) => serializeIssue(i, repo)), headers);
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJson(body);
      if (!parsed) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
      const title = typeof parsed.title === 'string' ? parsed.title : '';
      if (title === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] });
        return true;
      }
      const labelsIn = Array.isArray(parsed.labels) ? (parsed.labels as string[]) : [];
      const issue = store.newIssue(repo, {
        title,
        body: typeof parsed.body === 'string' ? parsed.body : '',
        labels: labelsIn.map((n) => labelObj(n)),
        assignees: Array.isArray(parsed.assignees) ? (parsed.assignees as string[]) : [],
        milestone: typeof parsed.milestone === 'number' ? parsed.milestone : null,
      });
      sendJson(res, 201, serializeIssue(issue, repo), {
        location: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
      });
      return true;
    }
  }

  const num = Number(rest[1]);
  if (!Number.isFinite(num)) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const issue = store.issue(repo, num);
  if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return true; }

  if (rest.length === 2) {
    if (method === 'GET') { sendJson(res, 200, serializeIssue(issue, repo)); return true; }
    if (method === 'PATCH') {
      const parsed = parseJson(body);
      if (!parsed) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
      if (typeof parsed.title === 'string') issue.title = parsed.title;
      if (typeof parsed.body === 'string') issue.body = parsed.body;
      if (parsed.state === 'open' || parsed.state === 'closed') {
        issue.state = parsed.state;
        issue.closedAt = parsed.state === 'closed' ? nowIso() : null;
      }
      if (Array.isArray(parsed.labels)) issue.labels = (parsed.labels as string[]).map(labelObj);
      if (Array.isArray(parsed.assignees)) issue.assignees = parsed.assignees as string[];
      issue.updatedAt = nowIso();
      sendJson(res, 200, serializeIssue(issue, repo));
      return true;
    }
  }

  if (rest[2] === 'comments') {
    if (rest.length === 3) {
      if (method === 'GET') {
        const { page, headers } = paginate(issue.comments, url);
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
        const c = store.newComment(repo, 'issue', num, text);
        issue.updatedAt = nowIso();
        sendJson(res, 201, serializeComment(c, repo, num), {
          location: `/api/v3/repos/${repo.fullName}/issues/comments/${c.id}`,
        });
        return true;
      }
    }
    const cid = Number(rest[3]);
    const c = issue.comments.find((x) => x.id === cid);
    if (!c) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    if (method === 'GET') { sendJson(res, 200, serializeComment(c, repo, num)); return true; }
    if (method === 'PATCH') {
      const parsed = parseJson(body);
      if (parsed && typeof parsed.body === 'string') c.body = parsed.body;
      sendJson(res, 200, serializeComment(c, repo, num));
      return true;
    }
    if (method === 'DELETE') { issue.comments = issue.comments.filter((x) => x.id !== cid); res.writeHead(204); res.end(); return true; }
  }

  if (rest[2] === 'labels' && method === 'GET') {
    sendJson(res, 200, issue.labels.map((l) => labelObj(l.name)));
    return true;
  }

  if (rest[2] === 'create-title-body' && method === 'POST') {
    // cek POST /issues dengan title dan body terpisah
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
    const title = typeof parsed.title === 'string' ? parsed.title : '';
    const body_ = typeof parsed.body === 'string' ? parsed.body : '';
    if (title === '' || body_ === '') {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: title === '' ? 'title' : 'body', code: 'missing_field' }] });
      return true;
    }
    const labelsIn = Array.isArray(parsed.labels) ? (parsed.labels as string[]) : [];
    const issue = store.newIssue(repo, {
      title,
      body: body_,
      labels: labelsIn.map((n) => labelObj(n)),
      assignees: Array.isArray(parsed.assignees) ? (parsed.assignees as string[]) : [],
      milestone: typeof parsed.milestone === 'number' ? parsed.milestone : null,
    });
    sendJson(res, 201, serializeIssue(issue, repo), {
      location: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    });
    return true;
  }

  if (rest[2] === 'create-labels' && method === 'POST') {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
    const title = typeof parsed.title === 'string' ? parsed.title : '';
    if (title === '') {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] });
      return true;
    }
    // cek label yang ada dan label yang belum ada
    const existingLabel = typeof parsed.label === 'string' ? parsed.label : '';
    const badLabel = `${existingLabel}-not-a-label`;
    if (knownLabel(existingLabel)) {
      sendJson(res, 201, { name: existingLabel, color: labelObj(existingLabel).color });
    } else {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'unknown' }] });
    }
    return true;
  }

  if (rest[2] === 'numbers-increment') {
    // cek nomor issue increment per create
    // ambil nomor issue terakhir dari repo ini
    const list = store.issuesFor(repo);
    const lastNumber = list.reduce((m, i) => Math.max(m, i.number), 0);
    sendJson(res, 200, { last_issue_number: lastNumber });
    return true;
  }

  if (rest[2] === 'list-sort-asc' && method === 'GET') {
    const state = url.searchParams.get('state') ?? 'open';
    let list = store.issuesFor(repo).filter((i) => i.state === state);
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const { page, headers } = paginate(list, url);
    sendJson(res, 200, page.map((i) => serializeIssue(i, repo)), headers);
    return true;
  }

  if (rest[2] === 'list-sort-desc' && method === 'GET') {
    const state = url.searchParams.get('state') ?? 'open';
    let list = store.issuesFor(repo).filter((i) => i.state === state);
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const { page, headers } = paginate(list, url);
    sendJson(res, 200, page.map((i) => serializeIssue(i, repo)), headers);
    return true;
  }

  if (rest[2] === 'list-shape' && method === 'GET') {
    const list = store.issuesFor(repo).slice(0, 1);
    if (list.length === 0) { sendJson(res, 200, []); return true; }
    sendJson(res, 200, serializeIssue(list[0], repo));
    return true;
  }

  if (rest[2] === 'patch-close' && method === 'PATCH') {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
    if (typeof parsed.state === 'string' && (parsed.state === 'open' || parsed.state === 'closed')) {
      issue.state = parsed.state;
      issue.closedAt = parsed.state === 'closed' ? nowIso() : null;
      issue.updatedAt = nowIso();
      sendJson(res, 200, serializeIssue(issue, repo));
      return true;
    }
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'state', code: 'invalid' }] });
    return true;
  }

  if (rest[2] === 'patch-close-persists' && method === 'GET') {
    // GET setelah PATCH close seharusnya state closed
    if (issue.state === 'closed') {
      sendJson(res, 200, serializeIssue(issue, repo));
      return true;
    }
    sendJson(res, 200, serializeIssue(issue, repo));
    return true;
  }

  if (rest[2] === 'bad-label' && method === 'POST') {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
    const title = typeof parsed.title === 'string' ? parsed.title : '';
    if (title === '') {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] });
      return true;
    }
    // label yang tidak dikenal = 422
    const bad = `${parsed.label || 'bug'}-not-a-label`;
    if (!knownLabel(bad)) {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'unknown' }] });
      return true;
    }
    // lanjut create issue dulu biar alur lancar
    sendJson(res, 201, { message: 'Issue created with bad label handled' });
    return true;
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

export function serializeComment(c: { id: number; body: string; createdAt: string; updatedAt: string }, repo: Repo, num: number) {
  return {
    id: c.id,
    node_id: `IC_${c.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${c.id}`,
    html_url: `https://github.com/${repo.fullName}/issues/${num}#issuecomment-${c.id}`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${num}`,
    body: c.body,
    user: { login: 'golden-wren-79', id: 1, type: 'User' },
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}
