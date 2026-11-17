// Git object store + SHA-1 hashing, pure node:crypto.
import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export const OBJ_TYPES: readonly ObjType[] = ['blob', 'tree', 'commit', 'tag'];

export function hashObject(type: ObjType, body: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${body.length}\u0000`, 'utf8');
  h.update(body);
  return h.digest('hex');
}

export function hashRaw(raw: Buffer): string {
  const h = createHash('sha1');
  h.update(raw);
  return h.digest('hex');
}

export function encodeObject(type: ObjType, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${body.length}\u0000`, 'utf8'), body]);
}

export function decodeObject(raw: Buffer): { type: ObjType; body: Buffer } | null {
  const nul = raw.indexOf(0);
  if (nul < 0) return null;
  const header = raw.subarray(0, nul).toString('utf8');
  const sp = header.indexOf(' ');
  if (sp < 0) return null;
  const type = header.slice(0, sp) as ObjType;
  if (!OBJ_TYPES.includes(type)) return null;
  const size = Number(header.slice(sp + 1));
  if (!Number.isFinite(size)) return null;
  const body = raw.subarray(nul + 1);
  if (body.length !== size) return null;
  return { type, body };
}

export function isValidOid(s: string): boolean {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

export const MODE_TREE = '40000';
export const MODE_BLOB = '100644';
export const MODE_EXEC = '100755';
export const MODE_LINK = '120000';
export const MODE_GITLINK = '160000';

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

// tree body = concat of "<mode> <name>\0<20-byte sha>"; entries must be sorted bytewise by name
function treeSortKey(e: TreeEntry): Buffer {
  const name = Buffer.from(e.name, 'utf8');
  // git appends '/' conceptually for trees when sorting
  return e.mode === MODE_TREE ? Buffer.concat([name, Buffer.from('/')]) : name;
}

export function buildTreeBody(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTreeBody(body: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = body.indexOf(0x00, sp);
    if (nul < 0) break;
    const mode = body.subarray(i, sp).toString('utf8');
    const name = body.subarray(sp + 1, nul).toString('utf8');
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

export interface CommitFields {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  encoding?: string;
  extra?: string[];
}

export function buildCommitBody(c: CommitFields): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  if (c.encoding) lines.push(`encoding ${c.encoding}`);
  for (const e of c.extra ?? []) lines.push(e);
  const head = lines.join('\n');
  return Buffer.from(`${head}\n\n${c.message}`, 'utf8');
}

export function parseCommitBody(body: Buffer): CommitFields {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const c: CommitFields = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) c.tree = line.slice(5);
    else if (line.startsWith('parent ')) c.parents.push(line.slice(7));
    else if (line.startsWith('author ')) c.author = line.slice(7);
    else if (line.startsWith('committer ')) c.committer = line.slice(10);
    else if (line.startsWith('encoding ')) c.encoding = line.slice(9);
  }
  return c;
}

export interface TagFields {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTagBody(body: Buffer): TagFields {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const t: TagFields = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) t.object = line.slice(7);
    else if (line.startsWith('type ')) t.type = line.slice(5) as ObjType;
    else if (line.startsWith('tag ')) t.tag = line.slice(4);
    else if (line.startsWith('tagger ')) t.tagger = line.slice(7);
  }
  return t;
}
