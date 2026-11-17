// pkt-line framing, as git's wire protocol uses it.
export const PKT_MAX = 65520;

export function encodePkt(line: Buffer | string): Buffer {
  const body = typeof line === 'string' ? Buffer.from(line, 'utf8') : line;
  const len = body.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'ascii'), body]);
}

export const FLUSH: Buffer = Buffer.from('0000', 'ascii');
export const DELIM: Buffer = Buffer.from('0001', 'ascii');
export const RESPONSE_END: Buffer = Buffer.from('0002', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  data: Buffer;
}

export function decodePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    i += 4;
    if (len === 0) {
      out.push({ kind: 'flush', data: Buffer.alloc(0) });
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', data: Buffer.alloc(0) });
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end', data: Buffer.alloc(0) });
      continue;
    }
    if (len < 4) break;
    const take = len - 4;
    if (i + take > buf.length) break;
    out.push({ kind: 'data', data: buf.subarray(i, i + take) });
    i += take;
  }
  return out;
}

/** Split a decoded data packet into trimmed lines (a line keeps no trailing LF). */
export function pktLines(buf: Buffer): string[] {
  return decodePkts(buf)
    .filter((p) => p.kind === 'data')
    .flatMap((p) => p.data.toString('utf8').split('\n'))
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0);
}

/** Frame `payload` into side-band-64k packets on `band` (1 = pack data, 2 = progress, 3 = error). */
export function sideband(band: 1 | 2 | 3, payload: Buffer): Buffer {
  const chunk = PKT_MAX - 5;
  const out: Buffer[] = [];
  for (let i = 0; i < payload.length; i += chunk) {
    const slice = payload.subarray(i, i + chunk);
    out.push(encodePkt(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (payload.length === 0) out.push(encodePkt(Buffer.from([band])));
  return Buffer.concat(out);
}

/** Read the side-band payload back out of a framed stream, per band. */
export function unsidedband(buf: Buffer): { band1: Buffer; band2: Buffer; band3: Buffer } {
  const parts: Buffer[] = [[], [], []];
  for (const p of decodePkts(buf)) {
    if (p.kind !== 'data' || p.data.length === 0) continue;
    const band = p.data[0];
    if (band >= 1 && band <= 3) parts[band - 1].push(p.data.subarray(1));
  }
  return {
    band1: Buffer.concat(parts[0] as Buffer[]),
    band2: Buffer.concat(parts[1] as Buffer[]),
    band3: Buffer.concat(parts[2] as Buffer[]),
  };
}
