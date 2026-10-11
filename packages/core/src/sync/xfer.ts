import type { BodyOf, MessageOf } from '../protocol/messages';
import { base64urlDecode, base64urlEncode } from '../util/base64url';

/**
 * Splits payloads that are too big for one message (device link, settings sync) into
 * numbered chunks, and puts them back together on the other side.
 */
export const CHUNK_BYTES = 9000; // 12 000 base64url characters, well below the message size limit
export const MAX_CHUNKS = 100;
const ASSEMBLY_TTL_MS = 10 * 60 * 1000;

export type XferPurpose = 'link' | 'sync';

export function chunkPayload(xferId: string, purpose: XferPurpose, payload: unknown): BodyOf<'xfer.chunk'>[] {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
  if (total > MAX_CHUNKS) throw new RangeError('payload too large');
  const out: BodyOf<'xfer.chunk'>[] = [];
  for (let part = 0; part < total; part++) {
    const data = base64urlEncode(bytes.subarray(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES));
    out.push({ type: 'xfer.chunk', xferId, purpose, part, total, data });
  }
  return out;
}

interface Assembly {
  sender: string;
  purpose: XferPurpose;
  total: number;
  parts: (string | undefined)[];
  received: number;
  startedAt: number;
}

/** Collects chunks per transfer. Bounded: few transfers at once, each with a time limit. */
export class Reassembler {
  private readonly open = new Map<string, Assembly>();

  constructor(private readonly maxOpen = 4) {}

  /**
   * Adds a chunk. Returns the parsed payload once every part arrived, otherwise undefined.
   * Chunks that contradict earlier ones (other sender, total or purpose) are ignored.
   */
  add(sender: string, m: MessageOf<'xfer.chunk'>, now: number): unknown {
    this.prune(now);
    if (m.part >= m.total) return undefined;
    const id = `${sender}|${m.xferId}`;
    let a = this.open.get(id);
    if (!a) {
      if (this.open.size >= this.maxOpen) return undefined;
      a = { sender, purpose: m.purpose, total: m.total, parts: new Array(m.total), received: 0, startedAt: now };
      this.open.set(id, a);
    }
    if (a.total !== m.total || a.purpose !== m.purpose) return undefined;
    if (a.parts[m.part] === undefined) {
      a.parts[m.part] = m.data;
      a.received++;
    }
    if (a.received < a.total) return undefined;
    this.open.delete(id);
    try {
      const chunks = a.parts.map((p) => base64urlDecode(p!));
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      return undefined;
    }
  }

  private prune(now: number): void {
    for (const [id, a] of this.open) if (now - a.startedAt > ASSEMBLY_TTL_MS) this.open.delete(id);
  }
}
