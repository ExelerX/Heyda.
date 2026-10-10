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
    expect(decodeInvite('socialapp:1:!!!').ok).toBe(false);
  });

  it('gives both sides the same safety number', () => {
    expect(safetyNumber(A, B)).toBe(safetyNumber(B, A));
    expect(safetyNumber(A, B)).toMatch(/^\d{5}( \d{5}){5}$/);
    expect(safetyNumber(A, B)).not.toBe(safetyNumber(A, 'c'.repeat(64)));
  });
});
