import { DEFAULT_CELL_M, type Alert, type ContactStatus } from '@heyda/core';
import { ago, etaWords, hhmm, inTime, remaining } from './format';

/** One-line descriptions of what a contact shares, for lists and the contact screen. */

export function placeEventText(p: NonNullable<ContactStatus['lastPlace']>, now = Date.now()): string {
  const verb = p.kind === 'arrive' ? `ist bei „${p.placeName}“ angekommen` : `hat „${p.placeName}“ verlassen`;
  return `${verb} · ${ago(p.at, now)}`;
}

export function quietText(dnd: { until?: number } | undefined, now = Date.now()): string | undefined {
  if (!dnd) return undefined;
  if (dnd.until !== undefined && dnd.until <= now) return undefined;
  return dnd.until !== undefined ? `Bitte nicht stören bis ${hhmm(dnd.until)}` : 'Bitte nicht stören';
}

export function statusText(s: { text?: string; emoji?: string; expiresAt: number } | undefined, now = Date.now()): string | undefined {
  if (!s || s.expiresAt <= now) return undefined;
  const t = [s.emoji, s.text].filter(Boolean).join(' ');
  return t || undefined;
}

/** "~2 km" for a grid cell size in metres (coarse locations are one cell of this size). */
export function cellSize(cellM: number = DEFAULT_CELL_M): string {
  const km = cellM / 1000;
  if (km < 1) return `~${Math.round(cellM / 100) * 100} m`;
  return `~${km % 1 === 0 ? km : km.toLocaleString('de-DE', { maximumFractionDigits: 1 })} km`;
}

/** Honest words for a coarse location: "ungefähr, ~2 km". */
export function coarseWords(cellM?: number): string {
  return `ungefähr, ${cellSize(cellM)}`;
}

/** How exact a share is, in words. Coarse uses the cell size when known (my own shares use the default grid). */
export function levelWords(level: 'coarse' | 'precise', cellM?: number): string {
  return level === 'precise' ? 'genau' : coarseWords(cellM);
}

export function liveText(live: NonNullable<ContactStatus['live']>, now = Date.now()): string {
  const parts = [`Live · ${levelWords(live.level, live.cell?.cellM)}`];
  if (!live.point && !live.cell) parts.push('wartet auf den ersten Standort');
  else parts.push(`aktualisiert ${ago(live.updatedAt, now)}`);
  if (live.expiresAt) parts.push(remaining(live.expiresAt, now));
  return parts.join(' · ');
}

export function tripText(trip: NonNullable<ContactStatus['trip']>, now = Date.now()): string {
  if (trip.etaMinutes === undefined) return `unterwegs nach „${trip.destinationName}“`;
  return `unterwegs nach „${trip.destinationName}“ · ${etaWords(trip.etaMinutes)}`;
}

/** When someone on a trip should arrive, from their last ETA update. */
export function arrivalAt(trip: NonNullable<ContactStatus['trip']>): number | undefined {
  return trip.etaMinutes === undefined ? undefined : trip.updatedAt + trip.etaMinutes * 60_000;
}

export function whereAnswerText(w: NonNullable<ContactStatus['lastWhere']>): string {
  const extra = w.text && w.answer !== 'text' ? ` „${w.text}“` : '';
  switch (w.answer) {
    case 'declined':
      return `🙊 möchte gerade nicht sagen, wo${extra}`;
    case 'text':
      return `💬 „${w.text ?? ''}“`;
    case 'place':
      return `📍 ist bei „${w.placeName ?? '…'}“${extra}`;
    case 'eta':
      return `🚗 unterwegs nach „${w.placeName ?? '…'}“${w.etaMinutes !== undefined ? `, ${etaWords(w.etaMinutes)}` : ''}${extra}`;
    case 'coarse':
      return `🗺️ hat die ungefähre Gegend geschickt (${cellSize(w.cell?.cellM)})${extra}`;
    case 'precise':
      return `📌 hat den genauen Standort geschickt${extra}`;
  }
}

export function watchText(w: { label: string; dueAt: number; firedAt?: number }, now = Date.now()): string {
  if (now >= w.dueAt) return `„${w.label}“: hätte sich bis ${hhmm(w.dueAt)} melden sollen`;
  return `„${w.label}“: meldet sich bis ${hhmm(w.dueAt)} (${inTime(w.dueAt, now)})`;
}

const CATEGORY_ICON: Record<Alert['category'], string> = {
  sos: '🆘',
  watch: '⏰',
  chat: '💬',
  ping: '👋',
  group: '👥',
  checkin: '✅',
  arrival: '📍',
  trip: '🚗',
  live: '📡',
  where: '🧭',
  status: '💭',
  contact: '🤝',
  automation: '⚡',
  device: '💻',
};

export function alertIcon(a: Pick<Alert, 'category'>): string {
  return CATEGORY_ICON[a.category] ?? '🔔';
}
