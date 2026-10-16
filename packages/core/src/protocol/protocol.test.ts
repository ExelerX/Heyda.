import { describe, expect, it } from 'vitest';
import { composeMessage } from './compose';
import { MAX_MESSAGE_BYTES, parseAppMessage, serializeAppMessage, type AppMessageBody, type MessageOf } from './messages';
import { decodeInvite, encodeInvite, InviteBook, safetyNumber } from '../pairing/invite';
import { base64urlDecode, base64urlEncode } from '../util/base64url';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('protocol', () => {
  it('round-trips every message type', () => {
    const bodies: AppMessageBody[] = [
      { type: 'hello', name: 'Lisa', relays: ['wss://relay.example.org'] },
      { type: 'session.start', sessionId: 'abcdefgh', level: 'eta', destinationName: 'Zuhause', expiresAt: 5 },
      { type: 'session.update', sessionId: 'abcdefgh', etaMinutes: 5 },
      { type: 'session.end', sessionId: 'abcdefgh', reason: 'arrived' },
      { type: 'place.event', kind: 'arrive', placeName: 'Supermarkt' },
      { type: 'chat.text', text: 'Hallo 👋' },
      { type: 'ping', kind: 'help-carry' },
    ];
    for (const body of bodies) {
      const m = composeMessage(body, 1);
      const parsed = parseAppMessage(serializeAppMessage(m));
      expect(parsed).toEqual({ ok: true, message: m });
    }
  });

  it('rejects unknown types and extra fields', () => {
    const m = composeMessage({ type: 'chat.text', text: 'hi' });
    expect(parseAppMessage(JSON.stringify({ ...m, type: 'exec' })).ok).toBe(false);
    expect(parseAppMessage(JSON.stringify({ ...m, lat: 52.5 })).ok).toBe(false);
  });

  it('rejects oversized payloads before parsing', () => {
    expect(parseAppMessage('"' + 'x'.repeat(MAX_MESSAGE_BYTES) + '"')).toEqual({ ok: false, error: 'message too large' });
  });

  it('accepts device-link hello and reveal only with a proper nonce and exactly 32 random bytes', () => {
    const r32 = base64urlEncode(new Uint8Array(32).fill(0xab));
    const hello = composeMessage({ type: 'link.hello', nonce: 'n'.repeat(20), rE: r32, relays: ['wss://relay.example.org'] }, 1);
    const reveal = composeMessage({ type: 'link.reveal', nonce: 'n'.repeat(20), rN: r32 }, 1);
    expect(parseAppMessage(serializeAppMessage(hello))).toEqual({ ok: true, message: hello });
    expect(parseAppMessage(serializeAppMessage(reveal))).toEqual({ ok: true, message: reveal });
    const bad = [
      { ...reveal, rN: base64urlEncode(new Uint8Array(31)) },
      { ...reveal, rN: base64urlEncode(new Uint8Array(33)) },
      // 43 characters, but not the canonical encoding of 32 bytes.
      { ...reveal, rN: r32.slice(0, 42) + 'B' },
      { ...reveal, rN: r32.slice(0, 42) + '+' },
      { ...reveal, nonce: 'short' },
      { ...reveal, nonce: 'n'.repeat(19) + ':' },
      { ...reveal, extra: 1 },
      { ...hello, rE: 'x' },
      { ...hello, relays: ['ws://plain.example'] },
      { ...hello, relays: Array(9).fill('wss://relay.example.org') },
    ];
    for (const m of bad) expect(parseAppMessage(JSON.stringify(m)).ok).toBe(false);
  });

  it('refuses non-TLS relays', () => {
    const m = { ...composeMessage({ type: 'hello', name: 'Lisa', relays: [] }), relays: ['ws://plain.example'] };
    expect(parseAppMessage(JSON.stringify(m)).ok).toBe(false);
  });

  it('refuses to serialize invalid messages', () => {
    const m = composeMessage({ type: 'chat.text', text: 'x' }) as MessageOf<'chat.text'>;
    expect(() => serializeAppMessage({ ...m, text: '' })).toThrow();
  });
});

describe('base64url', () => {
  it('round-trips all lengths', () => {
    for (let n = 0; n < 20; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
    }
  });
});

describe('pairing invites', () => {
  const self = { key: A, name: 'Lisa', relays: ['wss://relay.example.org'] };

  it('round-trips and expires', () => {
    const book = new InviteBook();
    const invite = book.create(self, 0);
    const text = encodeInvite(invite);
    expect(decodeInvite(text, 1000)).toEqual({ ok: true, invite });
    expect(decodeInvite(text, invite.expiresAt)).toEqual({ ok: false, error: 'invite has expired' });
  });

  it('can be answered only once', () => {
    const book = new InviteBook();
    const invite = book.create(self, 0);
    expect(book.consume(invite.nonce, 1)).toBe(true);
    expect(book.consume(invite.nonce, 2)).toBe(false);
    expect(book.consume('unknown-nonce', 2)).toBe(false);
  });

  it('rejects junk', () => {
    expect(decodeInvite('https://evil.example').ok).toBe(false);
    expect(decodeInvite('heyda:1:!!!').ok).toBe(false);
  });

  it('gives both sides the same safety number', () => {
    expect(safetyNumber(A, B)).toBe(safetyNumber(B, A));
    expect(safetyNumber(A, B)).toMatch(/^\d{5}( \d{5}){5}$/);
    expect(safetyNumber(A, B)).not.toBe(safetyNumber(A, 'c'.repeat(64)));
  });
});
