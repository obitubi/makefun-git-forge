// In-memory store: repositories, git objects, refs, issues, pulls, comments.
import { randomBytes, createHash } from 'node:crypto';
import { hashObject, encodeObject, parseTreeBody, parseCommitBody, buildCommitBody, type ObjType } from './objects.ts';

export interface Repo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  fork: boolean;
  isTemplate: boolean;
  homepage: string | null;
  topics: string[];
  archived: boolean;
  disabled: boolean;
  visibility: string;
  hasIssues: boolean;
  hasProjects: boolean;
  hasWiki: boolean;
  hasDownloads: boolean;
}

export interface Issue {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { id: number; name: string; color: string; description: string | null }[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  assignees: string[];
  milestone: number | null;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergedBy: string | null;
  comments: Comment[];
  commits: unknown[];
}

let nextRepoId = 1000;
let nextIssueId = 5000;
let nextPullId = 9000;
let nextCommentId = 7000;

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class Store {
  repos = new Map<string, Repo>();          // fullName (lowercased) -> repo
  objects = new Map<string, Map<string, { type: ObjType; body: Buffer }>>(); // repoKey -> oid -> obj
  refs = new Map<string, Map<string, string>>();  // repoKey -> refName -> oid
  issues = new Map<string, Issue[]>();      // repoKey -> issues
  pulls = new Map<string, Pull[]>();        // repoKey -> pulls
  token: string;
  login: string;
  personalToken: string;

  constructor(login: string, token: string) {
    this.login = login;
    this.token = token;
    this.personalToken = token;
  }

  newRepo(owner: string, name: string, patch: Partial<Repo> = {}): Repo {
    const fullName = `${owner}/${name}`;
    const repo: Repo = {
      id: nextRepoId++,
      name,
      owner,
      fullName,
      description: null,
      private: false,
      defaultBranch: 'main',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      fork: false,
      isTemplate: false,
      homepage: null,
      topics: [],
      archived: false,
      disabled: false,
      visibility: 'public',
      hasIssues: true,
      hasProjects: true,
      hasWiki: true,
      hasDownloads: true,
      ...patch,
    };
    this.repos.set(fullName.toLowerCase(), repo);
    this.objects.set(repo.fullName, new Map());
    this.refs.set(repo.fullName, new Map());
    this.issues.set(repo.fullName, []);
    this.pulls.set(repo.fullName, []);
    return repo;
  }

  find(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`.toLowerCase());
  }

  objStore(repo: Repo) {
    let m = this.objects.get(repo.fullName);
    if (!m) { m = new Map(); this.objects.set(repo.fullName, m); }
    return m;
  }

  refStore(repo: Repo) {
    let m = this.refs.get(repo.fullName);
    if (!m) { m = new Map(); this.refs.set(repo.fullName, m); }
    return m;
  }

  putObject(repo: Repo, type: ObjType, body: Buffer): string {
    const sha = hashObject(type, body);
    const s = this.objStore(repo);
    if (!s.has(sha)) s.set(sha, { type, body });
    return sha;
  }

  putRaw(repo: Repo, raw: Buffer): { sha: string; type: ObjType } | null {
    const nul = raw.indexOf(0);
    if (nul < 0) return null;
    const header = raw.subarray(0, nul).toString('utf8');
    const sp = header.indexOf(' ');
    if (sp < 0) return null;
    const type = header.slice(0, sp) as ObjType;
    if (!['blob', 'tree', 'commit', 'tag'].includes(type)) return null;
    const body = raw.subarray(nul + 1);
    const sha = createHash('sha1').update(raw).digest('hex');
    const s = this.objStore(repo);
    if (!s.has(sha)) s.set(sha, { type, body });
    return { sha, type };
  }

  getObject(repo: Repo, sha: string): { type: ObjType; body: Buffer } | undefined {
    return this.objStore(repo).get(sha);
  }

  hasObject(repo: Repo, sha: string): boolean {
    return this.objStore(repo).has(sha);
  }

  commitRaw(repo: Repo, sha: string): Buffer | undefined {
    const o = this.getObject(repo, sha);
    if (!o) return undefined;
    return encodeObject(o.type, o.body);
  }

  addIssue(repo: Repo, patch: { title: string; body?: string; labels?: string[]; user: string }): Issue {
    const list = this.issues.get(repo.fullName) ?? [];
    const number = list.reduce((m, i) => Math.max(m, i.number), 0) + 1;
    const issue: Issue = {
      id: nextIssueId++,
      number,
      repoId: repo.id,
      title: patch.title,
      body: patch.body ?? '',
      state: 'open',
      labels: (patch.labels ?? []).map((name) => labelObj(name)),
      user: patch.user,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      closedAt: null,
      comments: [],
      assignees: [],
      milestone: null,
    };
    list.push(issue);
    this.issues.set(repo.fullName, list);
    return issue;
  }

  issueList(repo: Repo) {
    return this.issues.get(repo.fullName) ?? [];
  }

  issue(repo: Repo, number: number) {
    return this.issueList(repo).find((i) => i.number === number);
  }

  addComment(issue: Issue, body: string, user: string): Comment {
    const c: Comment = { id: nextCommentId++, body, user, createdAt: nowIso(), updatedAt: nowIso() };
    issue.comments.push(c);
    issue.updatedAt = nowIso();
    return c;
  }

  addPull(repo: Repo, patch: {
    title: string; body?: string; headRef: string; headSha: string; baseRef: string; baseSha: string; user: string;
  }): Pull {
    const list = this.pulls.get(repo.fullName) ?? [];
    const number = list.reduce((m, p) => Math.max(m, p.number), 0) + 1;
    const pull: Pull = {
      id: nextPullId++,
      number,
      repoId: repo.id,
      title: patch.title,
      body: patch.body ?? '',
      state: 'open',
      merged: false,
      draft: false,
      head: patch.headRef,
      base: patch.baseRef,
      headSha: patch.headSha,
      baseSha: patch.baseSha,
      user: patch.user,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      closedAt: null,
      mergedAt: null,
      mergeCommitSha: null,
      mergedBy: null,
      comments: [],
      commits: [],
    };
    list.push(pull);
    this.pulls.set(repo.fullName, list);
    return pull;
  }

  pullList(repo: Repo) {
    return this.pulls.get(repo.fullName) ?? [];
  }

  pull(repo: Repo, number: number) {
    return this.pullList(repo).find((p) => p.number === number);
  }

  // ---- aliases + extras used by the REST/GraphQL layers ----

  issuesFor(repo: Repo) {
    return this.issueList(repo);
  }

  pullsFor(repo: Repo) {
    return this.pullList(repo);
  }

  newIssue(
    repo: Repo,
    patch: {
      title: string;
      body?: string;
      labels?: { id: number; name: string; color: string; description: string | null }[];
      assignees?: string[];
      milestone?: number | null;
    },
  ): Issue {
    const list = this.issuesFor(repo);
    const number = list.reduce((m, i) => Math.max(m, i.number), 0) + 1;
    const issue: Issue = {
      id: nextIssueId++,
      number,
      repoId: repo.id,
      title: patch.title,
      body: patch.body ?? '',
      state: 'open',
      labels: patch.labels ?? [],
      user: this.login,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      closedAt: null,
      comments: [],
      assignees: patch.assignees ?? [],
      milestone: patch.milestone ?? null,
    };
    list.push(issue);
    return issue;
  }

  newPull(
    repo: Repo,
    patch: {
      title: string;
      body?: string;
      head: string;
      base: string;
      headSha: string | null;
      baseSha: string | null;
      draft?: boolean;
    },
  ): Pull {
    const list = this.pullsFor(repo);
    const number = list.reduce((m, p) => Math.max(m, p.number), 0) + 1;
    const pull: Pull = {
      id: nextPullId++,
      number,
      repoId: repo.id,
      title: patch.title,
      body: patch.body ?? '',
      state: 'open',
      merged: false,
      draft: patch.draft === true,
      head: patch.head,
      base: patch.base,
      headSha: patch.headSha ?? '',
      baseSha: patch.baseSha ?? '',
      user: this.login,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      closedAt: null,
      mergedAt: null,
      mergeCommitSha: null,
      mergedBy: null,
      comments: [],
      commits: [],
    };
    list.push(pull);
    return pull;
  }

  newComment(repo: Repo, kind: 'issue' | 'pull', number: number, body: string): Comment {
    const target = kind === 'issue' ? this.issue(repo, number) : this.pull(repo, number);
    const c: Comment = { id: nextCommentId++, body, user: this.login, createdAt: nowIso(), updatedAt: nowIso() };
    if (target) target.comments.push(c);
    return c;
  }

  pullFiles(repo: Repo, pr: Pull) {
    const baseTree = pr.baseSha ? treeOf(this, repo, pr.baseSha) : new Map<string, string>();
    const headTree = pr.headSha ? treeOf(this, repo, pr.headSha) : new Map<string, string>();
    const out: { sha: string; filename: string; status: string; additions: number; deletions: number; changes: number; blob_url: string; raw_url: string; contents_url: string }[] = [];
    const names = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
    for (const name of names) {
      const a = baseTree.get(name);
      const b = headTree.get(name);
      if (a === b) continue;
      const status = a === undefined ? 'added' : b === undefined ? 'removed' : 'modified';
      out.push({
        sha: b ?? a ?? '',
        filename: name,
        status,
        additions: b ? 1 : 0,
        deletions: a ? 1 : 0,
        changes: (a ? 1 : 0) + (b ? 1 : 0),
        blob_url: `/api/v3/repos/${repo.fullName}/blob/${pr.headSha}/${name}`,
        raw_url: `https://raw.githubusercontent.com/${repo.fullName}/${pr.headSha}/${name}`,
        contents_url: `/api/v3/repos/${repo.fullName}/contents/${name}?ref=${pr.headSha}`,
      });
    }
    out.sort((x, y) => x.filename.localeCompare(y.filename));
    return out;
  }

  pullCommits(repo: Repo, pr: Pull) {
    if (!pr.headSha) return [];
    const seen = new Set<string>();
    const out: unknown[] = [];
    let cur: string | null = pr.headSha;
    const stop = pr.baseSha;
    while (cur && !seen.has(cur) && cur !== stop) {
      seen.add(cur);
      const obj = this.getObject(repo, cur);
      if (!obj || obj.type !== 'commit') break;
      const c = parseCommitBody(obj.body);
      out.push({
        sha: cur,
        commit: { message: c.message, author: splitIdent(c.author), committer: splitIdent(c.committer) },
        parents: c.parents.map((p) => ({ sha: p })),
      });
      cur = c.parents[0] ?? null;
    }
    return out;
  }

  mergePull(repo: Repo, pr: Pull, method: string, titleOverride: string | null): { ok: boolean; sha?: string; error?: string } {
    if (!pr.headSha || !pr.baseSha) return { ok: false, error: 'no commits' };
    const refs = this.refStore(repo);
    if (!this.hasObject(repo, pr.headSha)) return { ok: false, error: 'head object missing' };

    let newSha = pr.headSha;
    if (method !== 'rebase' && pr.baseSha !== pr.headSha) {
      const headObj = this.getObject(repo, pr.headSha);
      const baseObj = this.getObject(repo, pr.baseSha);
      if (!headObj || !baseObj) return { ok: false, error: 'missing objects' };
      const headCommit = parseCommitBody(headObj.body);
      const baseCommit = parseCommitBody(baseObj.body);
      const message = titleOverride ?? `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`;
      const body = buildCommitBody({
        tree: headCommit.tree,
        parents: [pr.baseSha, pr.headSha],
        author: baseCommit.author || `golden-wren-79 <golden-wren-79@users.noreply.github.com> ${Math.floor(Date.now() / 1000)} +0000`,
        committer: baseCommit.committer || baseCommit.author,
        message,
      });
      newSha = this.putObject(repo, 'commit', body);
    }
    refs.set(`refs/heads/${pr.base}`, newSha);
    if (repo.defaultBranch === pr.base) refs.set('HEAD', newSha);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = nowIso();
    pr.closedAt = pr.mergedAt;
    pr.updatedAt = pr.mergedAt;
    pr.mergeCommitSha = newSha;
    pr.mergedBy = this.login;
    repo.updatedAt = nowIso();
    return { ok: true, sha: newSha };
  }
}

/** Flat path -> blob sha map for a commit's tree. */
function treeOf(store: Store, repo: Repo, sha: string): Map<string, string> {
  const out = new Map<string, string>();
  const obj = store.getObject(repo, sha);
  if (!obj) return out;
  let treeSha = sha;
  if (obj.type === 'commit') {
    const c = parseCommitBody(obj.body);
    treeSha = c.tree;
  }
  walk(store, repo, treeSha, '', out);
  return out;
}

function walk(store: Store, repo: Repo, treeSha: string, prefix: string, out: Map<string, string>): void {
  const obj = store.getObject(repo, treeSha);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTreeBody(obj.body)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') walk(store, repo, e.sha, path, out);
    else out.set(path, e.sha);
  }
}

export function splitIdent(s: string) {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(s);
  if (!m) return { name: s, email: '', date: new Date(0).toISOString() };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

const LABELS: Record<string, { color: string; description: string | null }> = {
  bug: { color: 'd73a4a', description: "Something isn't working" },
  enhancement: { color: 'a2eeef', description: 'New feature or request' },
  documentation: { color: '0075ca', description: 'Improvements or additions to documentation' },
  question: { color: 'd876e3', description: 'Further information is requested' },
  'good first issue': { color: '7057ff', description: 'Good for newcomers' },
  'help wanted': { color: '008672', description: 'Extra attention is needed' },
  wontfix: { color: 'ffffff', description: 'This will not be worked on' },
  duplicate: { color: 'cfd3d7', description: 'This issue or pull request already exists' },
};

export function knownLabel(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LABELS, name.toLowerCase());
}

export function labelObj(name: string) {
  const meta = LABELS[name.toLowerCase()] ?? { color: 'ededed', description: null };
  const id = createHash('sha1').update(name).digest('hex').slice(0, 8);
  return { id: parseInt(id, 16), name, color: meta.color, description: meta.description };
}

export function randomToken(): string {
  return `ghp_${randomBytes(20).toString('hex')}`;
}
