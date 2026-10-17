import { z } from 'zod';
import { Rule } from '../automation/schema';
import type { Place } from '../geo/geofence';
import { normalizePrefs, type NotificationPrefs } from '../notify/prefs';
import type { PlaceGrant } from '../privacy/policy';
import { capGroups, type Contact, type Group, type MyStatus, type NodeState, type SyncField } from '../state';

/**
 * What my own devices keep in sync: contacts, groups, places, rules and settings.
 * Trips, live shares and SOS stay on the device that runs them; my watches go to the other
 * devices as messages of their own (`sync.watch`).
 *
 * Merging: contacts per contact (newest `updatedAt` wins, removals are remembered as
 * tombstones), groups per group (higher roster version wins, also over the hidden copy of a
 * group I was taken off, so being added back sticks; groups I left stay left),
 * everything else per field (newest change wins). Ties are broken the same way on every
 * device, so all of them end up with the same data.
 */
export interface SyncDoc {
  profileName: string;
  contacts: Contact[];
  removedContacts: { key: string; at: number }[];
  groups: Group[];
  /** Groups I left. Optional because devices running older versions do not send it. */
  leftGroups?: { id: string; at: number }[];
  places: Place[];
  grants: PlaceGrant[];
  rules: Rule[];
  prefs: NotificationPrefs;
  sosMessage?: string;
  status?: MyStatus;
  /**
   * The device that sends what automations send to others. Only present when one was chosen:
   * older versions read the doc strictly and would drop all of it for a field they do not know.
   */
  automationDevice?: string;
  rev: Partial<Record<SyncField, number>>;
}

const hex = z.string().regex(/^[0-9a-f]{64}$/);
const text = (max: number) => z.string().max(max);
const latLon = z.strictObject({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const relays = z.array(z.string().max(200).regex(/^wss:\/\//)).max(8);
const time = z.number().int().nonnegative();

const ContactSchema = z.strictObject({
  key: hex,
  name: text(40),
  relays,
  addedAt: time,
  verified: z.boolean(),
  nickname: text(40).optional(),
  favorite: z.boolean().optional(),
  muted: z.boolean().optional(),
  emergency: z.boolean().optional(),
  phone: text(32).optional(),
  updatedAt: time.optional(),
});

const groupId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const GroupSchema = z.strictObject({
  id: groupId,
  name: text(40),
  owner: hex,
  members: z.array(z.strictObject({ key: hex, name: text(40), relays: relays.optional() })).max(30),
  version: z.number().int().min(1),
  updatedAt: time,
  dissolved: z.boolean().optional(),
});

const SyncDocSchema = z.strictObject({
  profileName: text(40),
  contacts: z.array(ContactSchema).max(500),
  removedContacts: z.array(z.strictObject({ key: hex, at: time })).max(1000),
  groups: z.array(GroupSchema).max(100),
  leftGroups: z.array(z.strictObject({ id: groupId, at: time })).max(200).optional(),
  places: z
    .array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), name: text(60), center: latLon, radiusM: z.number().min(10).max(50_000) }))
    .max(100),
  grants: z
    .array(z.strictObject({ contactKey: hex, placeIds: z.array(z.string().max(64)).max(100), expiresAt: time.optional() }))
    .max(500),
  rules: z.array(Rule).max(200),
  prefs: z.unknown(),
  sosMessage: text(200).optional(),
  status: z.strictObject({ text: text(80).optional(), emoji: text(16).optional(), expiresAt: time }).optional(),
  automationDevice: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/).optional(),
  rev: z.record(z.string(), time),
});

export function buildSyncDoc(s: NodeState): SyncDoc {
  return {
    profileName: s.self.name,
    contacts: s.contacts,
    removedContacts: s.removedContacts,
    groups: s.groups,
    leftGroups: s.leftGroups,
    places: s.places,
    grants: s.grants,
    rules: s.rules,
    prefs: s.prefs,
    sosMessage: s.sosMessage,
    status: s.status,
    ...(s.automationDevice !== undefined ? { automationDevice: s.automationDevice } : {}),
    rev: s.syncRev,
  };
}

export function parseSyncDoc(input: unknown): SyncDoc | undefined {
  const r = SyncDocSchema.safeParse(input);
  if (!r.success) return undefined;
  return { ...r.data, prefs: normalizePrefs(r.data.prefs as Partial<NotificationPrefs>) } as SyncDoc;
}

const TOMBSTONE_KEEP_MS = 90 * 24 * 3600 * 1000;
const LEFT_GROUP_KEEP_MS = 180 * 24 * 3600 * 1000;

/** JSON with sorted keys, so the same data compares equal however its objects were built. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const stamp = (c: Contact) => c.updatedAt ?? c.addedAt;

/** Returns the state changes needed to take in a doc from another of my devices. */
export function mergeSyncDoc(s: NodeState, doc: SyncDoc, now: number): Partial<NodeState> {
  const patch: Partial<NodeState> = {};
  const rev = { ...s.syncRev };

  // Contacts: union, newest wins; a tombstone newer than the contact removes it.
  const tombstones = new Map<string, number>();
  for (const t of [...s.removedContacts, ...doc.removedContacts]) {
    if (now - t.at < TOMBSTONE_KEEP_MS) tombstones.set(t.key, Math.max(tombstones.get(t.key) ?? 0, t.at));
  }
  const byKey = new Map<string, Contact>();
  for (const c of [...s.contacts, ...doc.contacts]) {
    const prev = byKey.get(c.key);
    if (!prev || stamp(c) > stamp(prev) || (stamp(c) === stamp(prev) && canonicalJson(c) > canonicalJson(prev))) byKey.set(c.key, c);
  }
  const contacts = [...byKey.values()].filter((c) => (tombstones.get(c.key) ?? -1) < stamp(c));
  if (canonicalJson(contacts) !== canonicalJson(s.contacts)) patch.contacts = contacts;
  const removedContacts = [...tombstones].map(([key, at]) => ({ key, at }));
  if (canonicalJson(removedContacts) !== canonicalJson(s.removedContacts)) patch.removedContacts = removedContacts;

  // Groups I left on any device stay left, or another device would hand them back.
  const left = new Map<string, number>();
  for (const l of [...s.leftGroups, ...(doc.leftGroups ?? [])]) {
    if (now - l.at < LEFT_GROUP_KEEP_MS) left.set(l.id, Math.max(left.get(l.id) ?? 0, l.at));
  }
  const leftGroups = [...left].map(([id, at]) => ({ id, at }));
  if (canonicalJson(leftGroups) !== canonicalJson(s.leftGroups)) patch.leftGroups = leftGroups;

  // Groups: higher version (or same version, newer update) wins.
  const groups = new Map<string, Group>(s.groups.map((g) => [g.id, g]));
  for (const g of doc.groups) {
    const prev = groups.get(g.id);
    if (
      !prev ||
      g.version > prev.version ||
      (g.version === prev.version && (g.updatedAt > prev.updatedAt || (g.updatedAt === prev.updatedAt && canonicalJson(g) > canonicalJson(prev))))
    ) {
      groups.set(g.id, g);
    }
  }
  // Within what the other side takes (`groups` max 100): hidden copies of groups I was taken off give way first.
  const mergedGroups = capGroups([...groups.values()].filter((g) => !left.has(g.id)), 100);
  if (canonicalJson(mergedGroups) !== canonicalJson(s.groups)) patch.groups = mergedGroups;

  // Plain fields: newest change wins.
  const take = <F extends SyncField>(field: F, apply: () => void) => {
    const theirs = doc.rev[field] ?? 0;
    if (theirs > (s.syncRev[field] ?? 0)) {
      apply();
      rev[field] = theirs;
    }
  };
  take('profile', () => (patch.self = { ...s.self, name: doc.profileName }));
  take('places', () => (patch.places = doc.places));
  take('grants', () => (patch.grants = doc.grants));
  take('rules', () => (patch.rules = doc.rules));
  take('prefs', () => (patch.prefs = doc.prefs));
  take('sosMessage', () => (patch.sosMessage = doc.sosMessage));
  take('status', () => (patch.status = doc.status));
  take('automationDevice', () => (patch.automationDevice = doc.automationDevice));
  if (canonicalJson(rev) !== canonicalJson(s.syncRev)) patch.syncRev = rev;
  return patch;
}
