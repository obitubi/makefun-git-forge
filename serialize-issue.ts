// Issue JSON shapes.
import type { Store, Issue } from './store.ts';
import type { Repo } from './store.ts';

export function serializeIssue(issue: Issue, repo: Repo) {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    locked: false,
    user: { login: 'golden-wren-79', id: 1, node_id: 'U_1', type: 'User', site_admin: false },
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description, default: false })),
    assignee: issue.assignees.length ? { login: issue.assignees[0], id: 2, type: 'User' } : null,
    assignees: issue.assignees.map((a) => ({ login: a, id: 2, type: 'User' })),
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    labels_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/events`,
    pull_request: undefined as unknown,
  };
}

export function serializeIssueList(issues: Issue[], repo: Repo) {
  return issues.map((i) => serializeIssue(i, repo));
}

void StoreRef;
type StoreRef = Store;
