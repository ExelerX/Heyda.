import { isSessionActive, type SharingSession } from '../session/session';
import type { ContactKey } from '../transport/transport';
import { levelAllows } from './levels';

/**
 * A standing permission: which of my places may automatically tell this contact
 * "arrived" or "left". ETA and map data are never standing; they need a trip session.
 */
export interface PlaceGrant {
  contactKey: ContactKey;
  placeIds: string[];
  /** Epoch ms; `undefined` means until revoked. The app reminds the user regularly. */
  expiresAt?: number;
}

export interface PrivacyState {
  /** Ghost mode: no location-derived data leaves the device at all. Chat still works. */
  ghost: boolean;
  grants: PlaceGrant[];
}

export interface SessionUpdateFields {
  etaMinutes?: number;
  cell?: unknown;
  point?: unknown;
}

/**
 * The single gate every outgoing location-derived message passes through.
 * Keeping it in one small, pure, tested function makes the privacy promise auditable.
 */
export class PrivacyPolicy {
  constructor(private readonly state: () => PrivacyState) {}

  /** Contacts that may learn about arrive/leave at this place right now. */
  placeEventRecipients(placeId: string, now: number = Date.now()): ContactKey[] {
    const { ghost, grants } = this.state();
    if (ghost) return [];
    return grants
      .filter((g) => (g.expiresAt === undefined || now < g.expiresAt) && g.placeIds.includes(placeId))
      .map((g) => g.contactKey);
  }

  canSendSessionUpdate(
    to: ContactKey,
    session: SharingSession,
    fields: SessionUpdateFields,
    now: number = Date.now(),
  ): boolean {
    if (this.state().ghost) return false;
    if (!isSessionActive(session, now) || !session.recipients.includes(to)) return false;
    if (fields.etaMinutes !== undefined && !levelAllows(session.level, 'eta')) return false;
    if (fields.cell !== undefined && !levelAllows(session.level, 'coarse')) return false;
    if (fields.point !== undefined && !levelAllows(session.level, 'precise')) return false;
    return true;
  }

  canSendSessionLifecycle(to: ContactKey, session: SharingSession): boolean {
    // Start/end carry no location; still only to the chosen recipients.
    return session.recipients.includes(to);
  }
}
