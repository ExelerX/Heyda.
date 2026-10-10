/** German UI wording for times, kept in one place so it reads the same everywhere. */

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'gerade eben';
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `vor ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'gestern' : `vor ${d} Tagen`;
}

export function etaText(minutes: number | undefined): string {
  if (minutes === undefined) return 'unterwegs';
  if (minutes <= 0) return 'gleich da';
  if (minutes < 60) return `ca. ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `ca. ${h} h ${m} min` : `ca. ${h} h`;
}

export function timeLeft(until: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((until - now) / 60_000));
  if (m < 60) return `noch ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `noch ${h} h ${rest} min` : `noch ${h} h`;
}

export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const LEVEL_TEXT = {
  eta: { title: 'Nur Ankunftszeit', detail: 'Freunde sehen „ca. 10 min“, keinen Ort.' },
  coarse: { title: 'Ungefährer Bereich', detail: 'Ein Raster von etwa 2 km, nie die genaue Straße.' },
  precise: { title: 'Genauer Standort', detail: 'Für Treffpunkte. Endet spätestens nach 2 Stunden.' },
} as const;
