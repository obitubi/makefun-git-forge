// Smart HTTP v0: info/refs advertisement + upload-pack / receive-pack.
import type { IncomingHttpHeaders } from 'node:http';
import { Store, type Repo } from './store.ts';
import { encodePkt, FLUSH, sideband, decodePkts, unsidedband } from './pkt.ts';
import { readPack, writePack } from './pack.ts';
import {\n  parseTreeBody, buildTreeBody, buildCommitBody, parseCommitBody,\n  MODE_TREE, MODE_BLOB, isValidOid,
} from './objects.ts';

export type Service = 'git-upload-pack' | 'git-receive-pack';

const CAPS_COMMON = [
  'multi_ack', 'multi_ack_detailed', 'side-band-64k', 'thin-pack', 'ofs-delta',
  'agent=git/makefun-1.0', 'no-progress', 'include-tag', 'report-status',
  'report-status-v2', 'delete-refs', 'quiet', 'atomic', 'no-done', 'symref',
];

export function advertisement(repo: Repo, store: Store, service: Service): Buffer {
  const refs = store.refStore(repo);
  const caps = CAPS_COMMON.filter((c) => {
    if (service === 'git-upload-pack') {
      return !['report-status', 'report-status-v2', 'delete-refs', 'atomic'].includes(c);
    }
    return !['multi_ack', 'multi_ack_detailed', 'no-done'].includes(c);
  });
  if (service === 'git-upload-pack') {
    caps.push(`symref=HEAD:refs/heads/${repo.defaultBranch}`);
    // allow-tip / shallow style requests without extra server work
    caps.push('shallow', 'deepen-since', 'deepen-not', 'deepen-relative', 'filter');
  }

  const ordered: [string, string][] = [];
  const head = refs.get('HEAD');
  if (head) ordered.push(['HEAD', head]);
  const names = [...refs.keys()].filter((n) => n.startsWith('refs/')).sort();
  for (const n of names) ordered.push([n, refs.get(n)!]);

  if (ordered.length === 0) {
    const zero = '0'.repeat(40);
    return Buffer.concat([
      encodePkt(`${zero} capabilities^{}\u0000${caps.join(' ')}\n`),
      FLUSH,
    ]);
  }

  const out: Buffer[] = [];
  ordered.forEach(([name, sha], idx) => {
    if (idx === 0) out.push(encodePkt(`${sha} ${name}\u0000${caps.join(' ')}\n`));
    else out.push(encodePkt(`${sha} ${name}\n`));
  });
  out.push(FLUSH);
  return Buffer.concat(out);
}

export interface UploadPackRequest {
  wants: string[];
  haves: string[];
  done: boolean;
  shallows: string[];
  deepens: string[];
  caps: Set<string>;
}

export function parseUploadPack(body: Buffer): UploadPackRequest {
  const req: UploadPackRequest = { wants: [], haves: [], done: false, shallows: [], deepens: [], caps: new Set() };
  for (const p of decodePkts(body)) {
    if (p.kind !== 'data') continue;
    const text = p.data.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const [sha, ...caps] = text.slice(5).split(' ');
      req.wants.push(sha);
      if (caps.length) for (const c of caps) req.caps.add(c);
    } else if (text.startsWith('have ')) req.haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) req.shallows.push(text.slice(8));
    else if (text.startsWith('deepen ')) req.deepens.push(text.slice(7));
    else if (text === 'done') req.done = true;
  }
  return req;
}

function reachable(store: Store, repo: Repo, tips: string[], exclude: Set<string>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [...tips];
  while (stack.length) {
    const sha = stack.pop()!;
    if (!isValidOid(sha) || seen.has(sha) || exclude.has(sha)) continue;
    const obj = store.getObject(repo, sha);
    if (!obj) continue;
    seen.add(sha);
    order.push(sha);
    if (obj.type === 'commit') {
      const c = parseCommitBody(obj.body);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTreeBody(obj.body)) stack.push(e.sha);
    } else if (obj.type === 'tag') {
      const t = obj.body.toString('utf8');
      const m = /object ([0-9a-f]{40})/.exec(t);
      if (m) stack.push(m[1]);
    }
  }
  return order;
}

export function uploadPack(repo: Repo, store: Store, req: UploadPackRequest): Buffer {
  const useSideband = req.caps.has('side-band-64k');
  const haveSet = new Set(req.haves.filter(isValidOid));

  const objects = reachable(store, repo, req.wants, haveSet);
  const packInputs = objects
    .map((sha) => {
      const o = store.getObject(repo, sha)!;
      return { type: o.type, body: o.body, sha };
    });

  const pack = writePack(packInputs);

  const ackParts: Buffer[] = [];
  const negotiation = req.haves.length > 0;
  if (negotiation) {
    const know = req.haves.filter((h) => store.hasObject(repo, h));
    for (const h of know) ackParts.push(encodePkt(`ACK ${h}\n`));
    if (know.length === 0) ackParts.push(encodePkt('NAK\n'));
  } else {
    ackParts.push(encodePkt('NAK\n'));
  }

  if (!useSideband) {
    return Buffer.concat([Buffer.concat(ackParts), pack]);
  }
  return Buffer.concat([Buffer.concat(ackParts), sideband(1, pack), FLUSH]);
}

export interface PushCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

export function parseReceivePack(body: Buffer): { commands: PushCommand[]; caps: Set<string>; pack: Buffer } {
  const pkts = decodePkts(body);
  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  let idx = 0;
  for (; idx < pkts.length; idx++) {
    const p = pkts[idx];
    if (p.kind === 'flush') { idx++; break; }
    if (p.kind !== 'data') continue;
    const text = p.data.toString('utf8').replace(/\n$/, '');
    const zero = '0'.repeat(40);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(text);
    if (m) {
      commands.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
      if (commands.length === 1 && m[3].includes('\u0000')) {
        const [ref, capStr] = m[3].split('\u0000');
        commands[0].ref = ref;
        for (const c of (capStr ?? '').split(' ')) if (c) caps.add(c);
      } else if (commands.length === 1) {
        const sp = text.indexOf('\u0000');
        if (sp > 0) {
          const [ref, capStr] = text.slice(sp + 1).split('\u0000');
          commands[0].ref = text.slice(0, sp).split(' ')[2] ?? commands[0].ref;
          for (const c of (capStr ?? '').split(' ')) if (c) caps.add(c);
        }
      } else {
        void zero;
      }
    }
  }
  // remaining packets may be a raw packfile appended after the pkt-line section
  const rawTail = findPackTail(body);
  const pack = rawTail ?? (() => {
    const rest = pkts.slice(idx).filter((p) => p.kind === 'data').map((p) => p.data);
    const un = unsidedband(Buffer.concat(rest.map((r) => {
      const len = r.length + 4;
      return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), r]);
    })));
    return un.band1.length ? un.band1 : Buffer.concat(rest);
  })();
  return { commands, caps, pack };
}

function findPackTail(body: Buffer): Buffer | null {
  const sig = Buffer.from('PACK', 'ascii');
  const at = body.indexOf(sig);
  if (at < 0) return null;
  return body.subarray(at);
}

export interface PushReport {
  ref: string;
  ok: boolean;
  message?: string;
}

export function receivePack(repo: Repo, store: Store, body: Buffer): Buffer {
  const { commands, caps, pack } = parseReceivePack(body);
  const reports: PushReport[] = [];

  if (pack.length > 0) {
    try {
      for (const o of readPack(pack)) {
        const s = store.objStore(repo);
        if (!s.has(o.sha)) s.set(o.sha, { type: o.type, body: o.body });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reportBuffer([{ ref: commands[0]?.ref ?? 'refs/heads/main', ok: false, message: msg.slice(0, 200) }], caps);
    }
  }

  const refs = store.refStore(repo);
  for (const cmd of commands) {
    const zero = /^0+$/.test(cmd.newSha);
    if (zero) {
      if (cmd.ref.startsWith('refs/heads/') && refs.has(cmd.ref)) {
        refs.delete(cmd.ref);
        reports.push({ ref: cmd.ref, ok: true });
      } else {
        reports.push({ ref: cmd.ref, ok: false, message: 'ref does not exist' });
      }
      continue;
    }
    if (!store.hasObject(repo, cmd.newSha)) {
      reports.push({ ref: cmd.ref, ok: false, message: 'object not found' });
      continue;
    }
    refs.set(cmd.ref, cmd.newSha);
    if (cmd.ref.startsWith('refs/heads/')) {
      if (!refs.has('HEAD')) refs.set('HEAD', cmd.newSha);
    }
    reports.push({ ref: cmd.ref, ok: true });
  }

  return reportBuffer(reports, caps);
}

function reportBuffer(reports: PushReport[], caps: Set<string>): Buffer {
  const status = reports
    .map((r) => (r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.message ?? 'failed'}`))
    .join('\n');
  const unframed = encodePkt(`unpack ok\n`) && Buffer.concat([encodePkt('unpack ok\n')]);
  const lines = Buffer.concat([unframed, ...reports.map((r) => encodePkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.message ?? 'failed'}\n`)), FLUSH]);
  void status;
  if (caps.has('side-band-64k')) {
    return Buffer.concat([sideband(1, lines), FLUSH]);
  }
  return lines;
}

export function contentTypes(service: Service): string {
  return `application/x-${service}-advertisement`;
}

export function postContentType(service: Service): string {
  return `application/x-${service}-result`;
}

export function headerFor(headers: IncomingHttpHeaders): string | undefined {
  const v = headers['git-protocol'];
  return Array.isArray(v) ? v[0] : v;
}

void buildTreeBody;
void buildCommitBody;
void MODE_TREE;
void MODE_BLOB;
