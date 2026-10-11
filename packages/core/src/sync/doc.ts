import { z } from 'zod';
import { Rule } from '../automation/schema';
import type { Place } from '../geo/geofence';
import { normalizePrefs, type NotificationPrefs } from '../notify/prefs';
import type { PlaceGrant } from '../privacy/policy';
import type { Contact, Group, MyStatus, NodeState, SyncField } from '../state';

/**
 * What my own devices keep in sync: contacts, groups, places, rules and settings.
 * Trips, live shares and SOS stay on the device that runs them.
 *
 * Merging: contacts per contact (newest `updatedAt` wins, removals are remembered as
 * tombstones), groups per group (higher roster version wins), everything else per field
 * (newest change wins).
 */
export interface SyncDoc {
  profileName: string;
  contacts: Contact[];
  removedContacts: { key: string; at: number }[];
  groups: Group[];
  places: Place[];
  grants: PlaceGrant[];
  rules: Rule[];
  prefs: NotificationPrefs;
  sosMessage?: string;
  status?: MyStatus;
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

const GroupSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
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
  rev: z.record(z.string(), time),
});

export function buildSyncDoc(s: NodeState): SyncDoc {
  return {
    profileName: s.self.name,
    contacts: s.contacts,
    removedContacts: s.removedContacts,
    groups: s.groups,
    places: s.places,
    grants: s.grants,
    rules: s.rules,
    prefs: s.prefs,
    sosMessage: s.sosMessage,
    status: s.status,
    rev: s.syncRev,
  };
}

export function parseSyncDoc(input: unknown): SyncDoc | undefined {
  const r = SyncDocSchema.safeParse(input);
  if (!r.success) return undefined;
  return { ...r.data, prefs: normalizePrefs(r.data.prefs as Partial<NotificationPrefs>) } as SyncDoc;
}

const TOMBSTONE_KEEP_MS = 90 * 24 * 3600 * 1000;

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
    if (!prev || (c.updatedAt ?? c.addedAt) > (prev.updatedAt ?? prev.addedAt)) byKey.set(c.key, c);
  }
  const contacts = [...byKey.values()].filter((c) => (tombstones.get(c.key) ?? -1) < (c.updatedAt ?? c.addedAt));
  if (JSON.stringify(contacts) !== JSON.stringify(s.contacts)) patch.contacts = contacts;
  const removedContacts = [...tombstones].map(([key, at]) => ({ key, at }));
  if (JSON.stringify(removedContacts) !== JSON.stringify(s.removedContacts)) patch.removedContacts = removedContacts;

  // Groups: higher version (or same version, newer update) wins.
  const groups = new Map<string, Group>(s.groups.map((g) => [g.id, g]));
  for (const g of doc.groups) {
    const prev = groups.get(g.id);
    if (!prev || g.version > prev.version || (g.version === prev.version && g.updatedAt > prev.updatedAt)) groups.set(g.id, g);
  }
  const mergedGroups = [...groups.values()];
  if (JSON.stringify(mergedGroups) !== JSON.stringify(s.groups)) patch.groups = mergedGroups;

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
  if (JSON.stringify(rev) !== JSON.stringify(s.syncRev)) patch.syncRev = rev;
  return patch;
}
