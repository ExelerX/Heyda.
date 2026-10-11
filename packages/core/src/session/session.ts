import type { LatLon } from '../geo/types';
import { MAX_PRECISE_SHARE_MS } from '../privacy/levels';
import type { ContactKey } from '../transport/transport';
import { randomId } from '../util/random';

export type SessionLevel = 'eta' | 'coarse' | 'precise';

/**
 * One "I'm on my way" trip. Sharing always happens inside a session with an end:
 * on arrival, when stopped, or at `expiresAt`, whichever comes first.
 */
export interface SharingSession {
  id: string;
  recipients: ContactKey[];
  level: SessionLevel;
  destinationName: string;
  /** Kept on this device only; used for the local ETA estimate. */
  destination?: LatLon;
  startedAt: number;
  expiresAt: number;
  endedAt?: number;
}

export const DEFAULT_SESSION_MS = 2 * 60 * 60 * 1000;
export const MAX_SESSION_MS = 24 * 60 * 60 * 1000;
export const MAX_SESSION_RECIPIENTS = 20;

export interface CreateSessionInput {
  recipients: ContactKey[];
  level?: SessionLevel;
  destinationName: string;
  destination?: LatLon;
  durationMs?: number;
  now?: number;
}

export function createSession(input: CreateSessionInput): SharingSession {
  const now = input.now ?? Date.now();
  const level = input.level ?? 'eta';
  const recipients = [...new Set(input.recipients)];
  if (recipients.length === 0) throw new RangeError('a session needs at least one recipient');
  if (recipients.length > MAX_SESSION_RECIPIENTS) throw new RangeError('too many recipients');
  const name = input.destinationName.trim();
  if (!name || name.length > 60) throw new RangeError('destination name must be 1-60 characters');

  let duration = input.durationMs ?? DEFAULT_SESSION_MS;
  if (!(duration > 0)) throw new RangeError('duration must be positive');
  duration = Math.min(duration, MAX_SESSION_MS);
  if (level === 'precise') duration = Math.min(duration, MAX_PRECISE_SHARE_MS);

  return {
    id: randomId(),
    recipients,
    level,
    destinationName: name,
    destination: input.destination,
    startedAt: now,
    expiresAt: now + duration,
  };
}

export function isSessionActive(session: SharingSession, now: number = Date.now()): boolean {
  return session.endedAt === undefined && now < session.expiresAt;
}
