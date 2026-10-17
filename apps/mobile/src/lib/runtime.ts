import {
  BUILTIN_TEMPLATES,
  backupState,
  MemoryNetwork,
  SocialNode,
  createInitialState,
  decryptBackup,
  encryptBackup,
  importPlugin,
  normalizeState,
  randomId,
  restoredState,
  safetyNumber,
  storedPlugins,
  type Alarm,
  type BackupContents,
  type Alert,
  type ChatEntry,
  type ContactKey,
  type ContactStatus,
  type LinkStatus,
  type LocationNeeds,
  type NodeState,
  type Place,
  type PlaceGrant,
  type Plugin,
  type Rule,
  type RuleTemplate,
  type SharingSession,
} from '@heyda/core';
import { DEFAULT_RELAYS, MemorySeenStore, NostrTransport, type SeenSnapshot } from '@heyda/transport-nostr';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools/pure';
import { DEMO_KEYS, startDemoFriends } from './demo';
import { cancelAlarm, clearNotifications, deliverAlert, pruneAlarms, scheduleAlarm, setBadge, setOpenThread as setNotificationThread, showToast } from './notifications';
import { desktop, deviceLabel, isBrowserPreview, isDesktop } from './platform';
import type { Appearance } from './theme';
import { DesktopVault, EncryptedFileVault, MemoryVault, type Vault } from './vault';

export type { ChatEntry };

export interface Settings {
  onboarded: boolean;
  /** Demo mode: simulated friends in memory, nothing leaves the device. */
  demo: boolean;
  /** Dark unless the person picks otherwise. */
  appearance?: Appearance;
  /** Android: keep the connection open in the background (foreground service). */
  keepAlive: boolean;
  /** Show maps. Map tiles come from OpenStreetMap, which then sees the viewed area. */
  mapEnabled: boolean;
  /** After an SOS, also open an SMS to the emergency contacts' phone numbers. */
  smsFallback: boolean;
}

/** `os`: the phone's OS has it, so it rings even with the app closed (see `deliverAlert`). */
type SavedAlarm = Alarm & { os?: boolean };

interface Persisted {
  v: 2;
  state: NodeState;
  statuses: Record<ContactKey, ContactStatus>;
  /** Per thread: a contact key, or "g:" plus a group id. */
  chats: Record<string, ChatEntry[]>;
  unread: Record<string, number>;
  activity: Alert[];
  /** Alarms scheduled with the OS, so they can be re-armed or cancelled later. */
  alarms: SavedAlarm[];
  plugins: Plugin[];
  settings: Settings;
  seen: SeenSnapshot;
  /** The running trip, so it survives the OS killing and relaunching the app. */
  trip?: SharingSession;
  /** Set on a freshly linked device until my other devices were told about it. */
  announceLinked?: boolean;
}

export interface Snapshot {
  version: number;
  state: NodeState;
  statuses: Record<ContactKey, ContactStatus>;
  chats: Record<string, ChatEntry[]>;
  unread: Record<string, number>;
  unreadTotal: number;
  activity: Alert[];
  activeTrip: SharingSession | undefined;
  /** Minutes to the destination of my running trip, once known. */
  activeTripEta: number | undefined;
  templates: RuleTemplate[];
  plugins: Plugin[];
  settings: Settings;
  isDemo: boolean;
  dndActive: boolean;
  dndEndsAt: number | undefined;
  locationNeeds: LocationNeeds;
  /** Linking a new device from here: waiting for it, or the 6 digits to compare. */
  linkStatus: LinkStatus | undefined;
  /** False on a computer while my phone sends what automations send (they only notify here). */
  automationsActHere: boolean;
}

/** Hooks the platform layer (location, geofences) sets when a runtime is created. */
export interface PlatformHooks {
  onLocationNeeds: (needs: LocationNeeds) => void;
  onPlacesChange: (places: Place[]) => void;
  /** Gets one fresh location fix into the node, e.g. before an SOS. Resolves when done or given up. */
  freshFix: () => Promise<void>;
}

type CreatedHook = (runtime: AppRuntime) => void;
const createdHooks: CreatedHook[] = [];

/** Lets platform glue attach before anything can happen. */
export function onRuntimeCreated(hook: CreatedHook): void {
  createdHooks.push(hook);
}

const MAX_CHAT_PER_THREAD = 500;
/**
 * Character budgets for stored chats (UTF-16 units; emoji count double). Messages may be 4000
 * characters and contacts can create many groups, so without a budget a chatty or hostile
 * contact could grow the saved file until saving fails. The oldest messages go first.
 */
const MAX_CHAT_CHARS_PER_THREAD = 400_000;
const MAX_CHAT_CHARS_TOTAL = 3_000_000;
const MAX_ACTIVITY = 300;
const MAX_ALARMS = 100;
const MAX_ACTIVITY_TITLE = 200;
const MAX_ACTIVITY_BODY = 600;
const DATA_FILE = 'app-data';
const TICK_MS = 20_000;

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  demo: false,
  appearance: 'dark',
  keepAlive: false,
  mapEnabled: false,
  smsFallback: true,
};

/** The storage for this platform. */
export function createVault(): Vault {
  if (desktop) return new DesktopVault(desktop);
  if (isBrowserPreview) return new MemoryVault();
  return new EncryptedFileVault();
}

let sharedVault: Vault | undefined;
export function getVault(): Vault {
  sharedVault ??= createVault();
  return sharedVault;
}

function newDeviceId(): string {
  return randomId(16);
}

/** Brings data saved by older versions up to date. */
function migrate(raw: unknown, selfKey: string): Persisted | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const old = raw as Partial<Persisted> & { settings?: Partial<Settings> & { displayName?: string } };
  if (!old.state?.self) return undefined;
  const self = {
    ...old.state.self,
    key: selfKey,
    deviceId: old.state.self.deviceId || newDeviceId(),
    deviceName: old.state.self.deviceName || deviceLabel(),
  };
  const state = normalizeState({ ...old.state, self });
  return {
    v: 2,
    state,
    statuses: old.statuses ?? {},
    chats: old.chats ?? {},
    // Counts of chats that are gone (saved before they were cleaned up) would keep the badge up.
    unread: liveUnread(old.unread ?? {}, state),
    activity: Array.isArray(old.activity) ? old.activity : [],
    alarms: Array.isArray(old.alarms) ? old.alarms : [],
    // Checked again like an import: a plugin saved before a check existed is dropped.
    plugins: storedPlugins(old.plugins),
    settings: { ...DEFAULT_SETTINGS, ...old.settings },
    seen: old.seen ?? { sync: 0, ids: [] },
    trip: old.trip,
    announceLinked: old.announceLinked,
  };
}

export function freshData(selfKey: string, name = 'Ich', demo = false): Persisted {
  return {
    v: 2,
    state: createInitialState({ key: selfKey, name, relays: DEFAULT_RELAYS, deviceId: newDeviceId(), deviceName: deviceLabel() }),
    statuses: {},
    chats: {},
    unread: {},
    activity: [],
    alarms: [],
    plugins: [],
    settings: { ...DEFAULT_SETTINGS, demo },
    seen: { sync: 0, ids: [] },
  };
}

/** Writes app data for an account (after linking or restoring) before the runtime starts. */
export async function writeAccount(secretKey: Uint8Array, state: NodeState, extra: Partial<Persisted> = {}): Promise<void> {
  const vault = getVault();
  await vault.setSecretKey(secretKey);
  const data: Persisted = { ...freshData(getPublicKey(secretKey)), ...extra, state, v: 2 };
  data.settings = { ...DEFAULT_SETTINGS, ...extra.settings, onboarded: true, demo: false };
  await vault.save(DATA_FILE, data);
  // Alarms and notifications of the account (or demo) this one replaces: nothing in the new data
  // could cancel them, and they would ring or show names later.
  await clearNotifications();
}

/**
 * Owns the SocialNode for the whole app: building it from storage, saving changes
 * (encrypted, debounced), turning node events into chats, notifications and alarms,
 * and exposing a snapshot for React. Background tasks use the same instance.
 */
export class AppRuntime {
  private version = 0;
  private snapshotCache: Snapshot | undefined;
  private readonly listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private stopDemo: (() => void) | undefined;
  private openThread: string | undefined;
  private started = false;
  /** Set by shutdown(): late events and timers must not write over what replaced this instance. */
  private disposed = false;
  hooks: PlatformHooks = { onLocationNeeds: () => {}, onPlacesChange: () => {}, freshFix: async () => {} };

  private constructor(
    readonly node: SocialNode,
    private readonly vault: Vault,
    private data: Persisted,
    private readonly seen: MemorySeenStore,
    private readonly startDemo: ((node: SocialNode) => () => void) | undefined,
    /** Keeps a copy of the identity key in memory while running; shutdown() wipes it. */
    private readonly transport: NostrTransport | undefined,
  ) {
    node.on((e) => {
      switch (e.type) {
        case 'state': {
          const prev = this.data.state;
          const placesChanged = e.state.places !== prev.places;
          this.data.state = e.state;
          if (e.state.contacts !== prev.contacts || e.state.groups !== prev.groups) this.dropGoneThreads(prev);
          if (placesChanged && !this.isDemo) this.hooks.onPlacesChange(e.state.places);
          this.changed();
          break;
        }
        case 'status':
          this.data.statuses = { ...this.data.statuses, [e.contact]: e.status };
          this.changed();
          break;
        case 'chat':
          this.appendChat(e.thread, e.entry);
          break;
        case 'alert': {
          const id = e.alert.id;
          const watch = id.startsWith('watch:');
          // On Windows the alarm timer already rang for this watch; the core's overdue check reports it again.
          const rang = isDesktop && watch && this.data.activity.some((a) => a.id === id);
          this.addActivity(e.alert);
          // On a phone the OS has an alarm with the same id, which may have rung already.
          if (!rang) deliverAlert(e.alert, watch ? () => this.data.alarms.find((a) => a.id === id && a.os)?.at : undefined);
          break;
        }
        case 'alarm.schedule': {
          const alarm: SavedAlarm = { ...e.alarm };
          this.data.alarms = [...this.data.alarms.filter((a) => a.id !== alarm.id), alarm].slice(-MAX_ALARMS);
          const handedOver = () => {
            // Not if it was moved or cancelled meanwhile: that entry is no longer this one.
            if (this.disposed || !this.data.alarms.includes(alarm)) return;
            alarm.os = true;
            this.changed();
          };
          void scheduleAlarm(alarm, (a) => this.fireDesktopAlarm(a), handedOver).catch(() => {});
          this.changed();
          break;
        }
        case 'alarm.cancel':
          if (this.data.alarms.some((a) => a.id === e.id)) {
            this.data.alarms = this.data.alarms.filter((a) => a.id !== e.id);
            this.changed();
          }
          void cancelAlarm(e.id);
          break;
        case 'trip':
          this.data.trip = e.session;
          this.changed();
          break;
        case 'location':
          if (!this.isDemo) this.hooks.onLocationNeeds(e.needs);
          this.changed(false);
          break;
        case 'link':
          // Only in memory: nothing to save.
          this.changed(false);
          break;
        case 'contact.added':
          break;
      }
    });
  }

  static async create(): Promise<AppRuntime> {
    const vault = getVault();
    const secretKey = await vault.secretKey();
    const selfKey = getPublicKey(secretKey);
    const stored = migrate(await vault.load<unknown>(DATA_FILE), selfKey);
    const data = stored ?? freshData(selfKey, 'Ich', isBrowserPreview);
    // The browser preview can only ever run the demo: it has no safe place for keys. It keeps
    // nothing between page loads, so it skips onboarding (still reachable at /welcome) and every
    // screen can be opened directly by its address.
    if (isBrowserPreview) data.settings = { ...data.settings, demo: true, onboarded: stored ? data.settings.onboarded : true };
    const seen = MemorySeenStore.restore(data.seen);

    let node: SocialNode;
    let startDemo: ((node: SocialNode) => () => void) | undefined;
    let transport: NostrTransport | undefined;
    const common = { initialState: data.state, initialStatuses: data.statuses, deviceKind: isDesktop ? ('computer' as const) : ('phone' as const) };
    if (data.settings.demo) {
      const network = new MemoryNetwork();
      node = new SocialNode({ ...common, transport: network.createTransport(selfKey) });
      startDemo = (n) => startDemoFriends(network, n);
    } else {
      // Keeps its own copy of the key, so this array can be wiped below.
      transport = new NostrTransport({
        secretKey,
        ownRelays: data.state.self.relays.length ? data.state.self.relays : DEFAULT_RELAYS,
        relaysFor: (k) => node.relaysFor(k),
        // Strangers' messages are dropped before they take room in the saved seen store.
        accept: (from, message) => node.acceptsMessage(from, message),
        seen,
      });
      node = new SocialNode({ ...common, transport });
    }
    secretKey.fill(0);
    const runtime = new AppRuntime(node, vault, data, seen, startDemo, transport);
    for (const hook of createdHooks) hook(runtime);
    return runtime;
  }

  /** Connects to the network and starts the timers. Safe to call more than once. */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.node.start();
    if (this.data.trip && !this.node.resumeTrip(this.data.trip)) this.data.trip = undefined;
    if (this.startDemo) this.stopDemo = this.startDemo(this.node);
    // Alarms of the Windows app only live while it runs: re-arm them.
    if (isDesktop) for (const a of this.data.alarms) void scheduleAlarm(a, (x) => this.fireDesktopAlarm(x));
    // Phone alarms the OS kept from before (a restore, a link, the demo) that this data no longer
    // knows would ring for nothing. A full list may have lost old entries: then none are touched.
    else void pruneAlarms(() => (this.disposed || this.data.alarms.length >= MAX_ALARMS ? undefined : this.data.alarms)).catch(() => {});
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    // Not awaited: sending what waited in the outbox can take a while on a slow network, and the
    // screens (the SOS button too) and background tasks such as an iOS geofence wake must not wait.
    void this.firstRound();
    if (!this.isDemo) {
      this.hooks.onLocationNeeds(this.node.locationNeeds());
      this.hooks.onPlacesChange(this.data.state.places);
    }
  }

  private async firstRound(): Promise<void> {
    if (this.data.announceLinked) {
      this.data.announceLinked = false;
      await this.node.announceLinked().catch(() => {});
      this.changed();
    }
    if (!this.disposed) await this.tick();
  }

  /** Housekeeping: expiring shares, overdue alarms, outbox retries. Also called when the app wakes up. */
  async tick(): Promise<void> {
    await this.node.tick().catch(() => {});
    const now = Date.now();
    const alarms = this.data.alarms.filter((a) => a.at > now - 24 * 3600_000);
    if (alarms.length !== this.data.alarms.length) {
      this.data.alarms = alarms;
      this.changed();
    }
    this.changed(false);
  }

  // ---- React glue ------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => {
    if (!this.snapshotCache) {
      this.snapshotCache = {
        version: this.version,
        state: this.data.state,
        statuses: this.data.statuses,
        chats: this.data.chats,
        unread: this.data.unread,
        unreadTotal: unreadTotal(this.data.unread),
        activity: this.data.activity,
        activeTrip: this.node.activeTrip,
        activeTripEta: this.node.activeTripEta,
        isDemo: this.data.settings.demo,
        templates: [...BUILTIN_TEMPLATES, ...this.data.plugins.flatMap((p) => p.templates)],
        plugins: this.data.plugins,
        settings: this.data.settings,
        dndActive: this.node.isDndActive(),
        dndEndsAt: this.node.dndEndsAt(),
        locationNeeds: this.node.locationNeeds(),
        linkStatus: this.node.linkStatus,
        automationsActHere: this.node.runsAutomationActions,
      };
    }
    return this.snapshotCache;
  };

  // ---- small helpers for screens -------------------------------------------------------------

  get isDemo(): boolean {
    return this.data.settings.demo;
  }

  get settings(): Settings {
    return this.data.settings;
  }

  /** Numbers both people compare in person to rule out a swapped QR code. */
  safetyNumberWith(key: ContactKey): string {
    return safetyNumber(this.data.state.self.key, key);
  }

  /** The chat on screen: its messages count as read and need no banner. */
  setOpenThread(thread: string | undefined): void {
    this.openThread = thread;
    setNotificationThread(thread);
    if (thread) this.markRead(thread);
  }

  markRead(thread: string): void {
    if (!this.data.unread[thread]) return;
    const { [thread]: _read, ...rest } = this.data.unread;
    this.data.unread = rest;
    this.changed();
  }

  clearActivity(): void {
    this.data.activity = [];
    this.changed();
  }

  updateSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.changed();
  }

  setAppearance(appearance: Appearance): void {
    this.updateSettings({ appearance });
  }

  finishOnboarding(): void {
    this.updateSettings({ onboarded: true });
  }

  async setDisplayName(name: string): Promise<void> {
    await this.node.setProfileName(name.trim().slice(0, 40) || 'Ich');
  }

  // ---- places, grants, rules, plugins ---------------------------------------------------------

  savePlace(place: Omit<Place, 'id'> & { id?: string }): string {
    const id = place.id ?? randomId(10);
    this.node.setPlaces([...this.data.state.places.filter((p) => p.id !== id), { ...place, id }]);
    return id;
  }

  removePlace(id: string): void {
    this.node.setPlaces(this.data.state.places.filter((p) => p.id !== id));
    this.node.setGrants(this.data.state.grants.map((g) => ({ ...g, placeIds: g.placeIds.filter((p) => p !== id) })));
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
      this.data.plugins = [...this.data.plugins.filter((p) => p.id !== result.plugin.id), result.plugin].slice(-50);
      this.changed();
    }
    return result;
  }

  removePlugin(id: string): void {
    this.data.plugins = this.data.plugins.filter((p) => p.id !== id);
    this.changed();
  }

  async removeContact(key: ContactKey): Promise<void> {
    const { [key]: _chat, ...chats } = this.data.chats;
    const { [key]: _unread, ...unread } = this.data.unread;
    const { [key]: _status, ...statuses } = this.data.statuses;
    this.data.chats = chats;
    this.data.unread = unread;
    this.data.statuses = statuses;
    // Their messages, places and answers live on in the activity list too: the chat is meant to be gone.
    this.data.activity = this.data.activity.filter((a) => a.from !== key && a.thread !== key && a.ref?.sosOwner !== key);
    this.changed();
    await this.node.removeContact(key);
  }

  // ---- SOS --------------------------------------------------------------------------------

  /**
   * Starts (or renews) an SOS. Tries to get a fresh location first, but never waits longer
   * than a few seconds: getting help out matters more than a perfect position.
   */
  async triggerSos(input: { text?: string; recipients?: ContactKey[] } = {}): Promise<void> {
    if (!this.isDemo) {
      await Promise.race([this.hooks.freshFix().catch(() => {}), new Promise((r) => setTimeout(r, 6000))]);
    }
    await this.node.startSos(input);
    this.flushSoon();
  }

  // ---- own devices and backups -------------------------------------------------------------------

  /** The account key as hex, for sending it to a device being linked. Handle with care. */
  async secretKeyHex(): Promise<string> {
    const key = await this.vault.secretKey();
    const hex = bytesToHex(key);
    key.fill(0);
    return hex;
  }

  /** Starts linking the new device that shows this code. The digits then appear in `linkStatus`. */
  async startLink(code: string): Promise<void> {
    if (this.isDemo) throw new Error('Im Demo-Modus kann kein Gerät verbunden werden.');
    await this.node.startLink(code);
  }

  /** The digits matched: sends the account. The account key is read only now. */
  async confirmLink(): Promise<void> {
    if (this.isDemo) throw new Error('Im Demo-Modus kann kein Gerät verbunden werden.');
    if (this.node.linkStatus?.phase !== 'compare') throw new Error('Vergleiche zuerst die Zahlen auf beiden Geräten.');
    await this.node.confirmLink(await this.secretKeyHex());
  }

  cancelLink(): void {
    this.node.cancelLink();
  }

  /** A password-protected file with the account and settings, for moving to a new phone. */
  async exportBackup(password: string, onProgress?: (f: number) => void): Promise<Uint8Array> {
    if (this.isDemo) throw new Error('Im Demo-Modus gibt es nichts zu sichern.');
    const chats = Object.fromEntries(Object.entries(this.data.chats).map(([k, v]) => [k, v.slice(-100)]));
    // Without running live shares and SOS: restored weeks later, they would start again by themselves.
    const state = backupState(this.data.state);
    return encryptBackup(
      {
        format: 'heyda.backup',
        v: 1,
        createdAt: Date.now(),
        identity: await this.secretKeyHex(),
        data: { state, plugins: this.data.plugins, settings: this.data.settings, chats },
      },
      password,
      { onProgress },
    );
  }

  /** Stops everything; with `save`, writes the latest state first. */
  async shutdown(save = true): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.stopDemo?.();
    this.stopDemo = undefined;
    if (this.started) await this.node.stop().catch(() => {});
    this.started = false;
    // Wipes the key copy and closes the relay connections; this instance never sends again.
    await this.transport?.dispose().catch(() => {});
    if (save) await this.flush();
    // From here on nothing saves any more (also a save scheduled while the node was stopping):
    // a restore, a link or a wipe may be about to replace the data on disk.
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  /** Switches between demo and real mode. The caller rebuilds the runtime afterwards. */
  async setDemo(demo: boolean): Promise<void> {
    if (this.node.activeTrip) await this.node.stopTrip();
    this.data.settings = { ...this.data.settings, demo };
    await this.shutdown(false);
    if (!demo) this.removeDemoData();
    await this.write();
  }

  async wipeEverything(): Promise<void> {
    await this.shutdown(false);
    await this.vault.wipe([DATA_FILE]);
    // Also every alarm with the OS (the app's own list may have lost some) and the notifications
    // on screen, which show names and message previews.
    await clearNotifications();
  }

  /** Persist now, e.g. when the app goes to the background. */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.disposed) return;
    await this.write();
  }

  private async write(): Promise<void> {
    this.data.seen = this.seen.snapshot();
    this.data.statuses = this.node.exportStatuses();
    await this.vault.save(DATA_FILE, this.data);
  }

  /** For background tasks: persist only if something changed, before the OS suspends us. */
  async flushIfDirty(): Promise<void> {
    if (this.saveTimer) await this.flush();
  }

  // ---- internals ---------------------------------------------------------------------------

  private fireDesktopAlarm(alarm: Alarm): void {
    if (this.disposed || !this.data.alarms.some((a) => a.id === alarm.id && a.at === alarm.at)) return;
    // Rung once: without this, every restart within 24 h re-arms it with delay 0 and it rings again.
    this.data.alarms = this.data.alarms.filter((a) => a.id !== alarm.id);
    // The core's overdue check may have reported this watch a moment earlier; ring only once.
    const already = this.data.activity.some((a) => a.id === alarm.id);
    if (already) {
      this.changed();
      return;
    }
    const alert: Alert = { id: alarm.id, at: Date.now(), category: alarm.level === 'alarm' ? 'watch' : 'automation', level: alarm.level, title: alarm.title, body: alarm.body };
    this.addActivity(alert);
    deliverAlert(alert);
  }

  private addActivity(alert: Alert): void {
    const stored = { ...alert, title: clip(alert.title, MAX_ACTIVITY_TITLE), body: clip(alert.body, MAX_ACTIVITY_BODY) };
    this.data.activity = [stored, ...this.data.activity.filter((a) => a.id !== alert.id)].slice(0, MAX_ACTIVITY);
    this.changed();
  }

  /**
   * Leaving the demo: removes Lisa, Max and Oma Ilse and what belongs to them (also groups,
   * watches and an SOS made with them in the demo), nothing else. Statuses need nothing here:
   * the next start keeps only those of contacts.
   */
  private removeDemoData(): void {
    const demo = new Set(DEMO_KEYS);
    const mentionsDemo = (r: Rule) => DEMO_KEYS.some((k) => JSON.stringify(r).includes(k));
    const s = this.data.state;
    const groups = s.groups.flatMap((g) => {
      if (demo.has(g.owner)) return [];
      if (!g.members.some((m) => demo.has(m.key))) return [g];
      const members = g.members.filter((m) => !demo.has(m.key));
      return members.some((m) => m.key !== s.self.key) ? [{ ...g, members }] : [];
    });
    const goneThreads = new Set([...DEMO_KEYS, ...s.groups.filter((g) => !groups.some((x) => x.id === g.id)).map((g) => `g:${g.id}`)]);
    const watches = s.watches.filter((w) => !w.recipients.some((k) => demo.has(k)));
    const goneWatches = s.watches.filter((w) => !watches.includes(w)).map((w) => w.watchId);
    this.data.state = {
      ...s,
      contacts: s.contacts.filter((c) => !demo.has(c.key)),
      grants: s.grants.filter((g) => !demo.has(g.contactKey)),
      rules: s.rules.filter((r) => !mentionsDemo(r)),
      groups,
      liveShares: s.liveShares.filter((l) => !demo.has(l.contactKey)),
      watches,
      sos: s.sos?.recipients.some((k) => demo.has(k)) ? undefined : s.sos,
      outbox: s.outbox.filter((e) => !demo.has(e.to)),
      whereInbox: s.whereInbox.filter((w) => !demo.has(w.from)),
      whereAsked: s.whereAsked.filter((w) => !demo.has(w.from)),
      places: s.places.filter((p) => !p.id.startsWith('demo-')),
    };
    this.data.chats = Object.fromEntries(Object.entries(this.data.chats).filter(([t]) => !goneThreads.has(t)));
    this.data.unread = Object.fromEntries(Object.entries(this.data.unread).filter(([t]) => !goneThreads.has(t)));
    this.data.activity = this.data.activity.filter(
      (a) => !(a.from && demo.has(a.from)) && !(a.thread && goneThreads.has(a.thread)) && !(a.ref?.sosOwner && demo.has(a.ref.sosOwner)),
    );
    const goneAlarm = (id: string) => DEMO_KEYS.some((k) => id.startsWith(`watch:${k}:`)) || goneWatches.some((w) => id.startsWith(`mywatch:${w}:`));
    for (const a of this.data.alarms) if (goneAlarm(a.id)) void cancelAlarm(a.id).catch(() => {});
    this.data.alarms = this.data.alarms.filter((a) => !goneAlarm(a.id));
    this.data.trip = undefined;
  }

  private appendChat(thread: string, entry: ChatEntry): void {
    const list = this.data.chats[thread] ?? [];
    if (list.some((m) => m.id === entry.id)) return;
    this.data.chats = trimChats({ ...this.data.chats, [thread]: trimThread([...list, entry].slice(-MAX_CHAT_PER_THREAD)) });
    if (entry.from !== 'me' && thread !== this.openThread) {
      this.data.unread = { ...this.data.unread, [thread]: (this.data.unread[thread] ?? 0) + 1 };
      void setBadge(unreadTotal(this.data.unread));
    }
    this.changed();
  }

  /**
   * A contact removed (also on my other device) or a group gone for me (dissolved, taken off, left)
   * has no chat row to open any more: its messages, unread count and activity go, as when I remove
   * a contact here. Otherwise its unread count would keep the badge up for good. Only chats that
   * had a row before go: my own messages synced for a chat this device doesn't know yet stay.
   */
  private dropGoneThreads(prev: NodeState): void {
    const live = liveThreads(this.data.state);
    const gone = new Set([...liveThreads(prev)].filter((t) => !live.has(t)));
    const goneContacts = new Set(prev.contacts.map((c) => c.key).filter((k) => gone.has(k)));
    const unread = liveUnread(this.data.unread, this.data.state);
    if (!gone.size && unread === this.data.unread) return;
    const before = unreadTotal(this.data.unread);
    this.data.unread = unread;
    if (gone.size) {
      this.data.chats = Object.fromEntries(Object.entries(this.data.chats).filter(([t]) => !gone.has(t)));
      this.data.statuses = Object.fromEntries(Object.entries(this.data.statuses).filter(([k]) => !goneContacts.has(k)));
      this.data.activity = this.data.activity.filter(
        (a) => !(a.thread && gone.has(a.thread)) && !(a.from && goneContacts.has(a.from)) && !(a.ref?.sosOwner && goneContacts.has(a.ref.sosOwner)),
      );
    }
    if (unreadTotal(unread) !== before) void setBadge(unreadTotal(unread));
  }

  private flushSoon(): void {
    void this.flush().catch(this.reportSaveError);
  }

  private lastSaveError = 0;
  /** A failed save must not go unnoticed (full storage, a broken file); at most every 10 minutes. */
  private reportSaveError = (): void => {
    const now = Date.now();
    if (this.disposed || now - this.lastSaveError < 10 * 60_000) return;
    this.lastSaveError = now;
    showToast({
      id: 'save-failed',
      title: 'Speichern hat nicht geklappt',
      body: 'Heyda. konnte deine Daten gerade nicht sichern. Ist der Speicher voll? Neue Nachrichten könnten nach einem Neustart fehlen.',
      level: 'normal',
    });
  };

  private changed(persist = true): void {
    this.version++;
    this.snapshotCache = undefined;
    for (const l of [...this.listeners]) l();
    if (persist && !this.disposed) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => void this.flush().catch(this.reportSaveError), 500);
    }
  }
}

/** Reads a backup and, if the password is right, makes it this device's account. */
export async function restoreBackup(file: Uint8Array, password: string, onProgress?: (f: number) => void): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await decryptBackup(file, password, onProgress);
  if (!r.ok) return r;
  return restoreBackupContents(r.contents);
}

/**
 * Saves already decrypted backup contents as this device's account (no second, slow password
 * check). Stop the running runtime first and restart it afterwards.
 */
export async function restoreBackupContents(contents: BackupContents): Promise<{ ok: true } | { ok: false; error: string }> {
  const data = contents.data as Partial<Persisted> | undefined;
  if (!data?.state?.self || !/^[0-9a-f]{64}$/.test(contents.identity)) return { ok: false, error: 'Die Sicherung enthält keine App-Daten.' };
  const secret = hexToBytes(contents.identity);
  const key = getPublicKey(secret);
  // Live shares and SOS from older backup files end instead of starting again; messages still on
  // relays from before now fill in chats and statuses without ringing (see core `restoredState`).
  const state = restoredState({ ...data.state, self: { ...data.state.self, key, deviceId: newDeviceId(), deviceName: deviceLabel() } }, Date.now());
  await writeAccount(secret, state, {
    plugins: storedPlugins(data.plugins),
    settings: { ...DEFAULT_SETTINGS, ...data.settings, onboarded: true, demo: false },
    chats: cleanChats(data.chats),
  });
  secret.fill(0);
  return { ok: true };
}

/** Keeps only well-formed chat entries from a backup, within the usual limits. */
function cleanChats(input: unknown): Record<string, ChatEntry[]> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, ChatEntry[]> = {};
  for (const [thread, list] of Object.entries(input as Record<string, unknown>).slice(0, 1000)) {
    if (!/^([0-9a-f]{64}|g:[A-Za-z0-9_-]{1,64})$/.test(thread) || !Array.isArray(list)) continue;
    const entries = list.filter(
      (m): m is ChatEntry =>
        !!m &&
        typeof m === 'object' &&
        typeof m.id === 'string' &&
        typeof m.text === 'string' &&
        Number.isFinite(m.at) &&
        (m.from === 'me' || (typeof m.from === 'string' && /^[0-9a-f]{64}$/.test(m.from))) &&
        (m.kind === 'text' || m.kind === 'ping' || m.kind === 'system'),
    );
    if (entries.length) out[thread] = trimThread(entries.slice(-MAX_CHAT_PER_THREAD));
  }
  return trimChats(out);
}

let runtime: Promise<AppRuntime> | undefined;

/** The single runtime, created and started on first use (also from background tasks). */
export function getRuntime(): Promise<AppRuntime> {
  if (runtime) return runtime;
  const created = AppRuntime.create().then(async (r) => {
    await r.ensureStarted();
    return r;
  });
  runtime = created;
  // Only forget this attempt; a reset may already have put a newer one in its place.
  created.catch(() => {
    if (runtime === created) runtime = undefined;
  });
  return created;
}

/** Drops the instance so the next `getRuntime()` rebuilds it, e.g. after leaving demo mode. */
export function resetRuntime(): void {
  runtime = undefined;
}

/** The chats that have a row in the chat list: my contacts and the groups I am in. */
function liveThreads(state: NodeState): Set<string> {
  return new Set([...state.contacts.map((c) => c.key), ...state.groups.filter((g) => !g.dissolved).map((g) => `g:${g.id}`)]);
}

/** Unread counts of those chats only; the same object when nothing is dropped. */
function liveUnread(unread: Record<string, number>, state: NodeState): Record<string, number> {
  const live = liveThreads(state);
  const kept = Object.entries(unread).filter(([t]) => live.has(t));
  return kept.length === Object.keys(unread).length ? unread : Object.fromEntries(kept);
}

function unreadTotal(unread: Record<string, number>): number {
  return Object.values(unread).reduce((n, x) => n + x, 0);
}

/** Shortens text for storage without splitting an emoji. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

function chars(list: ChatEntry[]): number {
  return list.reduce((n, m) => n + m.text.length, 0);
}

/** Drops the oldest messages of one chat until it fits its budget (the newest always stays). */
export function trimThread(list: ChatEntry[]): ChatEntry[] {
  let total = chars(list);
  let start = 0;
  while (total > MAX_CHAT_CHARS_PER_THREAD && start < list.length - 1) total -= list[start++]!.text.length;
  return start ? list.slice(start) : list;
}

/** Drops the oldest messages across all chats until everything fits the overall budget. */
export function trimChats(chats: Record<string, ChatEntry[]>): Record<string, ChatEntry[]> {
  let total = Object.values(chats).reduce((n, l) => n + chars(l), 0);
  if (total <= MAX_CHAT_CHARS_TOTAL) return chats;
  const out = { ...chats };
  while (total > MAX_CHAT_CHARS_TOTAL) {
    let oldest: string | undefined;
    for (const [thread, list] of Object.entries(out)) {
      if (list.length > 1 && (oldest === undefined || list[0]!.at < out[oldest]![0]!.at)) oldest = thread;
    }
    if (oldest === undefined) break;
    const [dropped, ...rest] = out[oldest]!;
    out[oldest] = rest;
    total -= dropped!.text.length;
  }
  return out;
}
