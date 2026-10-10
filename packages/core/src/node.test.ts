import { describe, expect, it } from 'vitest';
import { instantiateTemplate, BUILTIN_TEMPLATES } from './automation/templates';
import type { Rule } from './automation/schema';
import { SocialNode, type NodeEvent, type NodeState } from './node';
import { MemoryNetwork } from './transport/memory';

const LISA = '1'.repeat(64);
const MAX = '2'.repeat(64);
const MALLORY = '3'.repeat(64);
const home = { lat: 52.52, lon: 13.405 };
const north = (meters: number) => ({ lat: home.lat + meters / 111_195, lon: home.lon });

const flush = () => new Promise((r) => setTimeout(r, 0));

function state(key: string, name: string): NodeState {
  return { self: { key, name, relays: [] }, contacts: [], places: [], grants: [], rules: [], ghost: false };
}

function rule(id: string, values: Record<string, string | number>): Rule {
  const r = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === id)!, values);
  if (!r.ok) throw new Error(r.errors.join(', '));
  return r.value;
}

async function pairedPair() {
  let clock = 1_000_000;
  const now = () => clock;
  const net = new MemoryNetwork();
  const lisa = new SocialNode({ transport: net.createTransport(LISA, now), initialState: state(LISA, 'Lisa'), now });
  const max = new SocialNode({ transport: net.createTransport(MAX, now), initialState: state(MAX, 'Max'), now });
  await lisa.start();
  await max.start();
  // Max shows a QR code, Lisa scans it.
  await lisa.acceptInvite(max.createInvite());
  await flush();
  return { net, lisa, max, tick: (ms: number) => (clock += ms), now };
}

describe('SocialNode', () => {
  it('pairs two phones through a scanned QR code', async () => {
    const { lisa, max } = await pairedPair();
    expect(lisa.getState().contacts.map((c) => c.name)).toEqual(['Max']);
    expect(max.getState().contacts.map((c) => c.name)).toEqual(['Lisa']);
  });

  it('drops messages from strangers and replayed invites', async () => {
    const { net, max } = await pairedPair();
    const events: NodeEvent[] = [];
    max.on((e) => events.push(e));
    const mallory = new SocialNode({ transport: net.createTransport(MALLORY), initialState: state(MALLORY, 'Mallory') });
    await mallory.start();
    // Mallory is not a contact of Max, so sending just does nothing on Mallory's side ...
    await mallory.sendChat(MAX, 'hi');
    // ... and a forged hello without a valid nonce is ignored by Max.
    const t = net.createTransport(MALLORY);
    await t.send(MAX, { v: 1, id: 'forged-hello-1', sentAt: 0, type: 'hello', name: 'Mallory', relays: [] });
    await flush();
    expect(max.getState().contacts.map((c) => c.name)).toEqual(['Lisa']);
    expect(events.filter((e) => e.type === 'contact.added')).toEqual([]);
  });

  it('shares a trip as rounded ETAs and fires "almost there" on the other phone', async () => {
    const { lisa, max, tick, now } = await pairedPair();
    max.setRules([rule('core.almost-there', { contact: LISA, minutes: 5 })]);
    const notes: string[] = [];
    max.on((e) => e.type === 'notify' && notes.push(e.intent.body));

    await lisa.startTrip({ recipients: [MAX], destinationName: 'Bei Max', destination: home, level: 'eta' });
    await flush();
    expect(max.getStatus(LISA).trip?.destinationName).toBe('Bei Max');

    // Walking towards home at ~1.4 m/s from 3 km away.
    for (const meters of [3000, 2500, 2000, 1500, 1000, 500, 300]) {
      tick(60_000);
      await lisa.onLocationFix({ ...north(meters), timestamp: now(), accuracyM: 10, speedMps: 8 });
      await flush();
    }
    const eta = max.getStatus(LISA).trip?.etaMinutes;
    expect(eta).toBeDefined();
    expect(eta!).toBeLessThanOrEqual(5);
    expect(notes).toEqual([expect.stringMatching(/^Lisa kommt (gleich|in ca\. \d+ min) an\.$/)]);
    // No coordinates ever reached Max at the "eta" level.
    expect(max.getStatus(LISA).trip?.cell).toBeUndefined();
    expect(max.getStatus(LISA).trip?.point).toBeUndefined();

    tick(60_000);
    await lisa.onLocationFix({ ...north(10), timestamp: now(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).trip).toBeUndefined();
    expect(lisa.activeTrip).toBeUndefined();
  });

  it('sends place events only for granted places and nothing in ghost mode', async () => {
    const { lisa, max, tick, now } = await pairedPair();
    lisa.setPlaces([{ id: 'store', name: 'Supermarkt', center: home, radiusM: 100 }]);
    lisa.setGrants([{ contactKey: MAX, placeIds: ['store'] }]);
    max.setRules([rule('core.shopping-help', { contact: LISA, place: 'Supermarkt' })]);
    const notes: string[] = [];
    max.on((e) => e.type === 'notify' && notes.push(e.intent.title));

    await lisa.onLocationFix({ ...north(0), timestamp: now(), accuracyM: 10 }); // starts inside, silent
    tick(60_000);
    await lisa.onLocationFix({ ...north(400), timestamp: now(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).lastPlace).toMatchObject({ kind: 'leave', placeName: 'Supermarkt' });
    expect(notes).toEqual(['Einkauf ist unterwegs 🛍️']);

    lisa.setGhost(true);
    tick(60_000);
    await lisa.onLocationFix({ ...north(0), timestamp: now(), accuracyM: 10 });
    tick(120_000);
    await lisa.onLocationFix({ ...north(0), timestamp: now(), accuracyM: 10 });
    await flush();
    expect(max.getStatus(LISA).lastPlace?.kind).toBe('leave');
  });

  it('lets an automation start a trip, but only at the ETA level', async () => {
    const { lisa, max, tick, now } = await pairedPair();
    lisa.setPlaces([
      { id: 'work', name: 'Arbeit', center: north(5000), radiusM: 150 },
      { id: 'home', name: 'Zuhause', center: home, radiusM: 100 },
    ]);
    lisa.setRules([rule('core.share-on-leave', { from: 'work', to: 'home', contact: MAX })]);
    await lisa.onLocationFix({ ...north(5000), timestamp: now(), accuracyM: 10 });
    tick(60_000);
    await lisa.onLocationFix({ ...north(4500), timestamp: now(), accuracyM: 10 });
    await flush();
    expect(lisa.activeTrip?.level).toBe('eta');
    expect(max.getStatus(LISA).trip?.destinationName).toBe('Zuhause');
  });
});
