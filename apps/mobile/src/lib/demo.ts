import { BUILTIN_TEMPLATES, createInitialState, instantiateTemplate, SocialNode, type MemoryNetwork, type NodeState } from '@heyda/core';

/** Fixed keys so demo friends can be recognised and removed when leaving demo mode. */
export const DEMO_LISA = 'a1'.repeat(32);
export const DEMO_MAX = 'b2'.repeat(32);
export const DEMO_OMA = 'c3'.repeat(32);
export const DEMO_KEYS = [DEMO_LISA, DEMO_MAX, DEMO_OMA];

/** A made-up spot; demo coordinates never touch the real location. */
const MY_HOME = { lat: 52.5208, lon: 13.4094 };
const STORE = { lat: 52.5246, lon: 13.4021 };
const OMA = { lat: 52.5098, lon: 13.3762 };

const friendState = (key: string, name: string): NodeState =>
  createInitialState({ key, name, relays: [], deviceId: `demo-${name.toLowerCase()}`, deviceName: 'Demo' });

/**
 * Three simulated friends on an in-memory network, driven by a script, so the app can
 * be tried (and screenshotted) without a second phone. They use the real protocol,
 * privacy gate and automation engine; nothing leaves the device.
 */
export function startDemoFriends(network: MemoryNetwork, me: SocialNode): () => void {
  const meKey = me.getState().self.key;
  const lisa = new SocialNode({ transport: network.createTransport(DEMO_LISA), initialState: friendState(DEMO_LISA, 'Lisa') });
  const max = new SocialNode({ transport: network.createTransport(DEMO_MAX), initialState: friendState(DEMO_MAX, 'Max') });
  const oma = new SocialNode({ transport: network.createTransport(DEMO_OMA), initialState: friendState(DEMO_OMA, 'Oma Ilse') });
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;
  const later = (ms: number, fn: () => void | Promise<void>) =>
    timers.push(setTimeout(() => !stopped && void Promise.resolve(fn()).catch(() => {}), ms));

  void (async () => {
    await lisa.start();
    await max.start();
    await oma.start();
    const known = new Set(me.getState().contacts.map((c) => c.key));
    // Pair through the normal QR flow: the friend shows a code, "I" scan it.
    if (!known.has(DEMO_LISA)) await me.acceptInvite(lisa.createInvite());
    if (!known.has(DEMO_MAX)) await me.acceptInvite(max.createInvite());
    if (!known.has(DEMO_OMA)) await me.acceptInvite(oma.createInvite());
    if (!known.size) {
      me.updateContact(DEMO_LISA, { favorite: true, emergency: true });
      me.updateContact(DEMO_OMA, { emergency: true });
    }
    seedRules(me);
    if (!me.getState().places.length) {
      me.setPlaces([{ id: 'demo-home', name: 'Zuhause', center: MY_HOME, radiusM: 100 }]);
      me.setGrants([{ contactKey: DEMO_LISA, placeIds: ['demo-home'] }]);
    }

    max.setPlaces([{ id: 'store', name: 'Supermarkt', center: STORE, radiusM: 80 }]);
    max.setGrants([{ contactKey: meKey, placeIds: ['store'] }]);
    oma.setPlaces([{ id: 'oma-home', name: 'Zuhause', center: OMA, radiusM: 80 }]);

    // Lisa answers an SOS, so the demo shows what happens after sending one.
    lisa.on((e) => {
      if (e.type === 'alert' && e.alert.ref?.sosOwner === meKey && e.alert.category === 'sos' && e.alert.level === 'alarm') {
        later(4000, () => lisa.ackSos(meKey, 'Bin unterwegs, rufe dich gleich an!'));
      }
    });
    later(800, () => max.setMyStatus({ text: 'Beim Sport', emoji: '🏋️', hours: 2 }));
    later(1500, () => max.onPlaceTransition('store', 'arrive'));
    later(2500, () => lisa.sendChat(meKey, 'Bin gleich unterwegs zu dir 🚗'));
    later(4000, () => runLisaTrip(lisa, meKey, later));
    later(6000, async () => {
      await oma.onLocationFix({ ...OMA, timestamp: Date.now(), accuracyM: 20 });
      await oma.startLive({ contacts: [meKey], level: 'coarse' });
    });
    later(9000, () => oma.sendCheckin({ to: [meKey], kind: 'home', text: 'Bin gut zuhause angekommen' }));
    later(14_000, () => max.onPlaceTransition('store', 'leave'));
    later(15_000, () => max.sendPing(meKey, 'help-carry'));
    // So the demo also shows answering a "Wo bist du?" question.
    later(25_000, () => max.askWhere(meKey));
  })();

  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
    void lisa.stop();
    void max.stop();
    void oma.stop();
  };
}

/** Lisa drives towards "my" place; each tick is a minute of simulated time. */
async function runLisaTrip(
  lisa: SocialNode,
  meKey: string,
  later: (ms: number, fn: () => void | Promise<void>) => void,
): Promise<void> {
  await lisa.startTrip({ recipients: [meKey], destinationName: 'Bei dir', destination: MY_HOME, level: 'eta' });
  let simTime = Date.now();
  const distances = [6000, 5300, 4600, 3900, 3200, 2600, 2000, 1500, 1000, 600, 300, 150, 40];
  distances.forEach((meters, i) => {
    later(i * 2500, async () => {
      simTime += 60_000;
      await lisa.onLocationFix({ lat: MY_HOME.lat + meters / 111_195, lon: MY_HOME.lon, timestamp: simTime, accuracyM: 15 });
    });
  });
  // Start over after a pause so the demo keeps showing something.
  later(distances.length * 2500 + 20_000, () => runLisaTrip(lisa, meKey, later));
}

function seedRules(me: SocialNode): void {
  if (me.getState().rules.length) return;
  const make = (id: string, values: Record<string, string | number>) => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === id);
    const r = t && instantiateTemplate(t, values);
    return r && r.ok ? [r.value] : [];
  };
  me.setRules([
    ...make('core.almost-there', { contact: DEMO_LISA, minutes: 5 }),
    ...make('core.shopping-help', { contact: DEMO_MAX, place: 'Supermarkt' }),
  ]);
}
