import { contactLabel, type Contact } from '@heyda/core';

/** Favourites first, then alphabetically by the name I see. */
export function sortContacts(contacts: Contact[]): Contact[] {
  return [...contacts].sort(
    (a, b) => Number(!!b.favorite) - Number(!!a.favorite) || contactLabel(a).localeCompare(contactLabel(b), 'de'),
  );
}

/** "Lisa", "Lisa und Max", "Lisa, Max und Oma Ilse" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}
