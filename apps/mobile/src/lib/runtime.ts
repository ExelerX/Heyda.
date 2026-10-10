import {
  MemoryNetwork,
  SocialNode,
  importPlugin,
  randomId,
  type ContactKey,
  type ContactStatus,
  type NodeState,
  type Place,
  type PlaceGrant,
  type Plugin,
  type Rule,
  type RuleTemplate,
  type SessionLevel,
  type SharingSession,
  BUILTIN_TEMPLATES,
  safetyNumber,
} from '@social-app/core';
import { DEFAULT_RELAYS, MemorySeenStore, NostrTransport } from '@social-app/transport-nostr';
import { getPublicKey } from 'nostr-tools/pure';
import { Platform } from 'react-native';
import { DEMO_KEYS, startDemoFriends } from './demo';
import type { Appearance } from './theme';
import { EncryptedFileVault, MemoryVault, type Vault } from './vault';

export interface ChatMessage {
  id: string;
  from: 'me' | ContactKey;
  text: string;
  at: number;
  kind: 'text' | 'ping';
}

export interface Settings {
  displayName: string;
  /** Demo mode: simulated friends in memory, nothing leaves the phone. */
  demo: boolean;
  onboarded: boolean;
  /** Dark unless the person picks otherwise. */
  appearance?: Appearance;
}

interface Persisted {
  state: NodeState;
  chats: Record<ContactKey, ChatMessage[]>;
  plugins: Plugin[];
  settings: Settings;
  seen: { sync: number; ids: string[] };
  /** The running trip, so it survives the OS killing and relaunching the app. */
  trip?: SharingSession;
}

export interface Snapshot {
  version: number;
  state: NodeState;
  statuses: Record<ContactKey, ContactStatus>;
  chats: Record<ContactKey, ChatMessage[]>;
  activeTrip: SharingSession | undefined;
  templates: RuleTemplate[];
  settings: Settings;
  isDemo: boolean;
}

export interface NotifySink {
  (title: string, body: string, from?: ContactKey): void;
}

type CreatedHook = (runtime: AppRuntime) => void;
const createdHooks: CreatedHook[] = [];

/** Lets platform glue (location, notifications) attach before anything can happen. */
export function onRuntimeCreated(hook: CreatedHook): void {
  createdHooks.push(hook);
}

const MAX_CHAT_PER_CONTACT = 500;
const DATA_FILE = 'app-data';

/**
 * Owns the SocialNode for the whole app: building it from storage, saving changes
 * (encrypted, debounced) and exposing a snapshot for React. Background location
 * tasks use the same instance through `getRuntime()`.
 */
export class AppRuntime {
  private version = 0;
  private snapshotCache: Snapshot | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly statuses: Record<ContactKey, ContactStatus> = {};
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private stopDemo: (() => void) | undefined;
  notify: NotifySink = () => {};
  onTripChange: (trip: SharingSession | undefined) => void = () => {};
  onPlacesChange: (places: Place[]) => void = () => {};

  private constructor(
    readonly node: SocialNode,
    private readonly vault: Vault,
    private data: Persisted,
    private readonly seen: MemorySeenStore,
  ) {
    node.on((e) => {
      switch (e.type) {
        case 'state':
          this.data.state = e.state;
          this.changed();
          break;
        case 'status':
          this.statuses[e.contact] = e.status;
          this.changed(false);
          break;
        case 'trip':
          this.data.trip = e.session;
          this.onTripChange(e.session);
          this.changed();
          break;
        case 'notify':
          this.notify(e.intent.title, e.intent.body);
          break;
        case 'message': {
          const m = e.message;
          if (m.type === 'chat.text' || m.type === 'ping') {
            const text = m.type === 'chat.text' ? m.text : (m.text ?? pingLabel(m.kind));
            this.appendChat(e.from, { id: m.id, from: e.from, text, at: Date.now(), kind: m.type === 'ping' ? 'ping' : 'text' });
            this.notify(this.contactName(e.from), text, e.from);
          }
          break;
        }
      }
    });
  }

  static async create(): Promise<AppRuntime> {
    const web = Platform.OS === 'web';
    const vault: Vault = web ? new MemoryVault() : new EncryptedFileVault();
    const secretKey = await vault.secretKey();
    const selfKey = getPublicKey(secretKey);
    const stored = await vault.load<Persisted>(DATA_FILE);
    const data: Persisted = stored ?? {
      state: {
        self: { key: selfKey, name: 'Ich', relays: DEFAULT_RELAYS },
        contacts: [],
        places: [],
        grants: [],
        rules: [],
        ghost: false,
      },
      chats: {},
      plugins: [],
      settings: { displayName: 'Ich', demo: web, onboarded: false, appearance: 'dark' },
      seen: { sync: 0, ids: [] },
    };
    const seen = MemorySeenStore.restore(data.seen);

    let node: SocialNode;
    let demoStarter: ((node: SocialNode) => () => void) | undefined;
    if (data.settings.demo) {
      const network = new MemoryNetwork();
      node = new SocialNode({ transport: network.createTransport(selfKey), initialState: data.state });
      demoStarter = (n) => startDemoFriends(network, n);
    } else {
      const transport = new NostrTransport({
        secretKey,
        ownRelays: data.state.self.relays,
        relaysFor: (k) => node.getState().contacts.find((c) => c.key === k)?.relays ?? [],
        seen,
      });
      node = new SocialNode({ transport, initialState: data.state });
    }

    const runtime = new AppRuntime(node, vault, data, seen);
    for (const hook of createdHooks) hook(runtime);
    await node.start();
    if (data.trip && !node.resumeTrip(data.trip)) data.trip = undefined;
    if (demoStarter) runtime.stopDemo = demoStarter(node);
    return runtime;
  }

  // ---- React glue ---------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => {
    this.snapshotCache ??= {
      version: this.version,
      state: this.data.state,
      statuses: { ...this.statuses },
      chats: this.data.chats,
      activeTrip: this.node.activeTrip,
      isDemo: this.data.settings.demo,
      templates: [...BUILTIN_TEMPLATES, ...this.data.plugins.flatMap((p) => p.templates)],
      settings: this.data.settings,
    };
    return this.snapshotCache;
  };

  // ---- actions ----------------------------------------------------------------------

  get isDemo(): boolean {
    return this.data.settings.demo;
  }

  /** Numbers both people compare in person to rule out a swapped QR code. */
  safetyNumberWith(key: ContactKey): string {
    return safetyNumber(this.data.state.self.key, key);
  }

  markVerified(key: ContactKey): void {
    this.node.markVerified(key);
  }

  contactName(key: ContactKey): string {
    return this.data.state.contacts.find((c) => c.key === key)?.name ?? 'Unbekannt';
  }

  async sendChat(to: ContactKey, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    await this.node.sendChat(to, trimmed);
    this.appendChat(to, { id: randomId(), from: 'me', text: trimmed, at: Date.now(), kind: 'text' });
  }

  async sendPing(to: ContactKey, kind: 'help-carry' | 'pickup-request'): Promise<void> {
    await this.node.sendPing(to, kind);
    this.appendChat(to, { id: randomId(), from: 'me', text: pingLabel(kind), at: Date.now(), kind: 'ping' });
  }

  startTrip(input: {
    recipients: ContactKey[];
    destinationName: string;
    destination?: { lat: number; lon: number };
    level: SessionLevel;
    durationMs?: number;
  }): Promise<SharingSession> {
    return this.node.startTrip(input);
  }

  stopTrip(): Promise<void> {
    return this.node.stopTrip();
  }

  setGhost(on: boolean): void {
    this.node.setGhost(on);
  }

  async setDisplayName(name: string): Promise<void> {
    const clean = name.trim().slice(0, 40) || 'Ich';
    this.data.settings = { ...this.data.settings, displayName: clean };
    await this.node.setProfileName(clean);
  }

  setAppearance(appearance: Appearance): void {
    this.data.settings = { ...this.data.settings, appearance };
    this.changed();
  }

  finishOnboarding(): void {
    this.data.settings = { ...this.data.settings, onboarded: true };
    this.changed();
  }

  savePlace(place: Omit<Place, 'id'> & { id?: string }): void {
    const id = place.id ?? randomId(10);
    const places = [...this.data.state.places.filter((p) => p.id !== id), { ...place, id }];
    this.node.setPlaces(places);
    this.onPlacesChange(places);
  }

  removePlace(id: string): void {
    const places = this.data.state.places.filter((p) => p.id !== id);
    this.node.setPlaces(places);
    this.node.setGrants(
      this.data.state.grants.map((g) => ({ ...g, placeIds: g.placeIds.filter((p) => p !== id) })),
    );
    this.onPlacesChange(places);
  }

  /** Which of my places a contact may hear arrive/leave events for. */
  setPlaceGrant(contactKey: ContactKey, placeIds: string[]): void {
    const others = this.data.state.grants.filter((g) => g.contactKey !== contactKey);
    const grants: PlaceGrant[] = placeIds.length ? [...others, { contactKey, placeIds }] : others;
    this.node.setGrants(grants);
  }

  saveRule(rule: Rule): void {
    this.node.setRules([...this.data.state.rules.filter((r) => r.id !== rule.id), rule]);
  }

  toggleRule(id: string, enabled: boolean): void {
    this.node.setRules(this.data.state.rules.map((r) => (r.id === id ? { ...r, enabled } : r)));
  }

  removeRule(id: string): void {
    this.node.setRules(this.data.state.rules.filter((r) => r.id !== id));
  }

  installPlugin(raw: string): ReturnType<typeof importPlugin> {
    const result = importPlugin(raw);
    if (result.ok) {
      this.data.plugins = [...this.data.plugins.filter((p) => p.id !== result.plugin.id), result.plugin];
      this.changed();
    }
    return result;
  }

  createInvite(): string {
    return this.node.createInvite();
  }

  acceptInvite(text: string) {
    return this.node.acceptInvite(text);
  }

  removeContact(key: ContactKey): void {
    const { [key]: _removed, ...rest } = this.data.chats;
    this.data.chats = rest;
    this.node.removeContact(key);
  }

  /** Switches between demo and real mode. The caller rebuilds the runtime afterwards. */
  async setDemo(demo: boolean): Promise<void> {
    this.data.settings = { ...this.data.settings, demo };
    await this.shutdown(false);
    if (!demo) this.removeDemoData();
    await this.flush();
  }

  async wipeEverything(): Promise<void> {
    await this.shutdown(false);
    await this.vault.wipe([DATA_FILE]);
  }

  /** Stops everything; with `save`, writes the latest state first. */
  async shutdown(save = true): Promise<void> {
    this.stopDemo?.();
    this.stopDemo = undefined;
    if (this.node.activeTrip) await this.node.stopTrip();
    await this.node.stop();
    if (save) await this.flush();
    else if (this.saveTimer) clearTimeout(this.saveTimer);
  }

  /** Persist now, e.g. when the app goes to the background. */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.data.seen = this.seen.snapshot();
    await this.vault.save(DATA_FILE, this.data);
  }

  /** For background tasks: persist only if something changed, before the OS suspends us. */
  async flushIfDirty(): Promise<void> {
    if (this.saveTimer) await this.flush();
  }

  // ---- internals -------------------------------------------------------------------

  private removeDemoData(): void {
    const isDemo = (k: string) => DEMO_KEYS.includes(k);
    const mentionsDemo = (r: Rule) => DEMO_KEYS.some((k) => JSON.stringify(r).includes(k));
    const s = this.data.state;
    this.data.state = {
      ...s,
      contacts: s.contacts.filter((c) => !isDemo(c.key)),
      grants: s.grants.filter((g) => !isDemo(g.contactKey)),
      rules: s.rules.filter((r) => !mentionsDemo(r)),
    };
    this.data.chats = Object.fromEntries(Object.entries(this.data.chats).filter(([k]) => !isDemo(k)));
    this.data.trip = undefined;
  }

  private appendChat(contact: ContactKey, message: ChatMessage): void {
    const list = [...(this.data.chats[contact] ?? []), message].slice(-MAX_CHAT_PER_CONTACT);
    this.data.chats = { ...this.data.chats, [contact]: list };
    this.changed();
  }

  private changed(persist = true): void {
    this.version++;
    this.snapshotCache = undefined;
    for (const l of this.listeners) l();
    if (persist) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => void this.flush(), 400);
    }
  }
}

export function pingLabel(kind: 'help-carry' | 'pickup-request' | 'custom'): string {
  if (kind === 'help-carry') return '🛍️ Kannst du beim Tragen helfen?';
  if (kind === 'pickup-request') return '🚗 Kannst du mich abholen?';
  return '👋';
}

let runtime: Promise<AppRuntime> | undefined;

/** The single runtime, created on first use (also from background tasks). */
export function getRuntime(): Promise<AppRuntime> {
  runtime ??= AppRuntime.create();
  return runtime;
}

/** Drops the instance so the next `getRuntime()` rebuilds it, e.g. after leaving demo mode. */
export function resetRuntime(): void {
  runtime = undefined;
}
