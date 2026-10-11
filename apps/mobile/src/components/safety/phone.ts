/** Accepts "+49 170 1234567", "0170/1234567", "(030) 123-456"; returns "+491701234567" style. */
export function checkPhone(raw: string): { ok: true; value: string | undefined } | { ok: false; error: string } {
  const s = raw.trim();
  if (!s) return { ok: true, value: undefined };
  if (!/^\+?[\d\s()/-]+$/.test(s)) return { ok: false, error: 'Bitte nur Ziffern, Leerzeichen und ein + am Anfang.' };
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6) return { ok: false, error: 'Die Nummer ist zu kurz.' };
  if (digits.length > 15) return { ok: false, error: 'Die Nummer ist zu lang (höchstens 15 Ziffern).' };
  return { ok: true, value: `${s.startsWith('+') ? '+' : ''}${digits}` };
}
