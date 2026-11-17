// zlib packfile writer + reader for git smart HTTP transfer.
import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { ObjType } from './objects.ts';
import { encodeObject, OBJ_TYPES } from './objects.ts';

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodeTypeSize(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  let rest = size >>> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export interface PackInput {
  type: ObjType;
  body: Buffer;
  sha: string;
}

/** Build a non-delta packfile (version 2) containing every given object. */
export function writePack(objects: PackInput[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from('PACK', 'ascii'));
  parts.push(u32(2));
  parts.push(u32(objects.length));
  for (const o of objects) {
    const header = encodeTypeSize(TYPE_NUM[o.type], o.body.length);
    const compressed = deflateSync(o.body);
    parts.push(header, compressed);
  }
  const body = Buffer.concat(parts);
  const sum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, sum]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

export interface PackedObject {
  sha: string;
  type: ObjType;
  body: Buffer;
}

/** Parse a packfile (deltas supported) and return every object with its recomputed SHA-1. */
export function readPack(buf: Buffer): PackedObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('bad pack signature');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const end = buf.length - 20;
  const entries: { type: ObjType | 'ofs-delta' | 'ref-delta'; body: Buffer; base?: number; baseSha?: string }[] = [];
  let i = 12;

  while (i < end && entries.length < count) {
    let c = buf[i++];
    const typeNum = (c >> 4) & 7;
    let size = c & 0x0f;
    let shift = 4;
    while (c & 0x80) {
      c = buf[i++];
      size |= (c & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjType | 'ofs-delta' | 'ref-delta';
    if (typeNum === 6) type = 'ofs-delta';
    else if (typeNum === 7) type = 'ref-delta';
    else if (NUM_TYPE[typeNum]) type = NUM_TYPE[typeNum];
    else throw new Error(`bad pack object type ${typeNum}`);

    let base: number | undefined;
    let baseSha: string | undefined;
    if (type === 'ofs-delta') {
      let b = buf[i++];
      let off = b & 0x7f;
      while (b & 0x80) {
        b = buf[i++];
        off = ((off + 1) << 7) | (b & 0x7f);
      }
      base = i - off;
    } else if (type === 'ref-delta') {
      baseSha = buf.subarray(i, i + 20).toString('hex');
      i += 20;
    }

    const { value, next } = inflateAt(buf, i);
    i = next;
    if (value.length !== size) throw new Error(`pack object size mismatch: header ${size}, inflated ${value.length}`);
    entries.push({ type, body: value, base, baseSha });
  }

  const byOffset = new Map<number, PackedObject>();
  const bySha = new Map<string, PackedObject>();

  // resolve in two passes: plain objects first, then deltas whose base is now known
  const offsets: number[] = [];
  {
    let p = 12;
    for (let k = 0; k < entries.length; k++) {
      offsets.push(p);
      p = skipEntry(buf, p);
    }
  }

  const resolve = (idx: number, depth = 0): PackedObject => {
    if (depth > 64) throw new Error('delta chain too deep');
    const cached = byOffset.get(offsets[idx]);
    if (cached) return cached;
    const e = entries[idx];
    let out: PackedObject;
    if (e.type === 'ofs-delta' || e.type === 'ref-delta') {
      let baseObj: PackedObject | undefined;
      if (e.type === 'ofs-delta') {
        const bIdx = offsets.indexOf(e.base!);
        if (bIdx < 0) throw new Error('ofs-delta base not found');
        baseObj = resolve(bIdx, depth + 1);
      } else {
        baseObj = bySha.get(e.baseSha!);
        if (!baseObj) throw new Error(`ref-delta base ${e.baseSha} missing from pack`);
      }
      const body = applyDelta(baseObj.body, e.body);
      out = { sha: hashOf(baseObj.type, body), type: baseObj.type, body };
    } else {
      out = { sha: hashOf(e.type as ObjType, e.body), type: e.type as ObjType, body: e.body };
    }
    byOffset.set(offsets[idx], out);
    bySha.set(out.sha, out);
    return out;
  };

  const result: PackedObject[] = [];
  for (let k = 0; k < entries.length; k++) result.push(resolve(k));
  return result;
}

function hashOf(type: ObjType, body: Buffer): string {
  return createHash('sha1').update(encodeObject(type, body)).digest('hex');
}

function skipEntry(buf: Buffer, start: number): number {
  let i = start;
  let c = buf[i++];
  while (c & 0x80) c = buf[i++];
  // need the type to know about base refs
  const typeNum = (buf[start] >> 4) & 7;
  if (typeNum === 6) {
    let b = buf[i++];
    while (b & 0x80) b = buf[i++];
  } else if (typeNum === 7) {
    i += 20;
  }
  return inflateEnd(buf, i);
}

function inflateAt(buf: Buffer, start: number): { value: Buffer; next: number } {
  // inflate progressively: zlib streams inside a pack end at their own boundary
  const slice = buf.subarray(start);
  const value = inflateSync(slice);
  // recompute how many compressed bytes were consumed by re-inflating with a stream
  const next = inflateEnd(buf, start);
  return { value, next };
}

function inflateEnd(buf: Buffer, start: number): number {
  const { Inflate } = require('node:zlib') as typeof import('node:zlib');
  let consumed = 0;
  const chunks: Buffer[] = [];
  const inf = new Inflate();
  inf.on('data', (d: Buffer) => chunks.push(d));
  let i = start;
  const step = 4096;
  while (i < buf.length) {
    const piece = buf.subarray(i, Math.min(i + step, buf.length));
    try {
      inf.write(piece);
      consumed += piece.length;
      i += piece.length;
      if (inf._readableState?.ended) break;
      inf.flush(() => {});
    } catch {
      break;
    }
  }
  inf.close();
  return start + consumed;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const srcSize = readVarint(delta, () => i, (v) => (i = v));
  if (srcSize !== base.length) throw new Error(`delta base size mismatch ${srcSize} vs ${base.length}`);
  const dstSize = readVarint(delta, () => i, (v) => (i = v));
  const out = Buffer.alloc(dstSize);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off |= delta[i++];
      if (op & 0x02) off |= delta[i++] << 8;
      if (op & 0x04) off |= delta[i++] << 16;
      if (op & 0x08) off |= delta[i++] << 24;
      if (op & 0x10) size |= delta[i++];
      if (op & 0x20) size |= delta[i++] << 8;
      if (op & 0x40) size |= delta[i++] << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, o, off, off + size);
      o += size;
    } else if (op > 0) {
      delta.copy(out, o, i, i + op);
      o += op;
      i += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  return out;
}

function readVarint(buf: Buffer, cur: () => number, set: (v: number) => void): number {
  let i = cur();
  let shift = 0;
  let value = 0;
  let b = buf[i++];
  value |= b & 0x7f;
  while (b & 0x80) {
    b = buf[i++];
    value |= (b & 0x7f) << (shift += 7);
  }
  set(i);
  return value;
}
