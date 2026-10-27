import { BACKUP_MIN_PASSWORD } from '@heyda/core';

export interface Strength {
  /** 0 too short, 1 weak, 2 okay, 3 strong. */
  level: 0 | 1 | 2 | 3;
  label: string;
  tip: string;
}

const COMMON = ['passwort', 'password', '1234567890', 'qwertz', 'qwerty', 'heyda', 'hallo', 'geheim'];

/** A rough, friendly strength hint. Not a guarantee, just a nudge towards longer passwords. */
export function passwordStrength(pw: string): Strength {
  const chars = [...pw];
  if (chars.length < BACKUP_MIN_PASSWORD) {
    const missing = BACKUP_MIN_PASSWORD - chars.length;
    return { level: 0, label: 'Zu kurz', tip: `Noch ${missing} Zeichen, mindestens ${BACKUP_MIN_PASSWORD} insgesamt.` };
  }
  const lower = pw.toLowerCase();
  const classes = [/[a-zäöüß]/, /[A-ZÄÖÜ]/, /\d/, /[^A-Za-z0-9äöüÄÖÜß\s]/, /\s/].filter((r) => r.test(pw)).length;
  const unique = new Set(chars).size;
  let score = 0;
  if (chars.length >= 12) score++;
  if (chars.length >= 16) score++;
  if (chars.length >= 22) score++;
  if (classes >= 3) score++;
  if (unique < 5) score -= 2;
  if (COMMON.some((c) => lower.includes(c))) score -= 1;
  if (score >= 3) return { level: 3, label: 'Stark', tip: 'Sehr gut. Schreib es dir trotzdem auf.' };
  if (score >= 1) return { level: 2, label: 'Okay', tip: 'Länger ist besser: z. B. vier zufällige Wörter.' };
  return { level: 1, label: 'Schwach', tip: 'Tipp: ein kurzer Satz oder vier zufällige Wörter sind stark und gut zu merken.' };
}
