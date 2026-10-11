import { contactLabel, type Contact } from '@heyda/core';
import { router } from 'expo-router';
import { View } from 'react-native';
import { spacing } from '../../lib/theme';
import { Button, Chip, Empty, Row, T, Wrap } from '../ui';

/** Favourites and emergency contacts; if there is only one contact, that one. Nothing is remembered. */
export function defaultRecipients(contacts: Contact[]): string[] {
  const picked = contacts.filter((c) => c.favorite || c.emergency).map((c) => c.key);
  if (picked.length) return picked;
  return contacts.length === 1 ? [contacts[0]!.key] : [];
}

/** Keeps only keys that are still contacts (one may have been removed while the screen was open). */
export function stillContacts(keys: string[], contacts: Contact[]): string[] {
  return keys.filter((k) => contacts.some((c) => c.key === k));
}

export function namesOf(keys: string[], contacts: Contact[], fallback = 'Unbekannt'): string {
  const names = keys.map((k) => {
    const c = contacts.find((x) => x.key === k);
    return c ? contactLabel(c) : fallback;
  });
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

/** Shown instead of a picker when there is nobody to send to yet. */
export function NoContacts({ text }: { text: string }) {
  return (
    <Empty
      icon="👋"
      title="Noch keine Kontakte"
      text={text}
      action={<Button title="Freund hinzufügen" icon="➕" onPress={() => router.push('/pair')} compact />}
    />
  );
}

/** Chips to pick contacts. ⭐ marks favourites, 🆘 emergency contacts. */
export function ContactPicker({
  contacts,
  selected,
  onChange,
  label = 'Empfänger',
}: {
  contacts: Contact[];
  selected: string[];
  onChange: (keys: string[]) => void;
  label?: string;
}) {
  const sorted = [...contacts].sort(
    (a, b) =>
      Number(!!b.emergency) - Number(!!a.emergency) ||
      Number(!!b.favorite) - Number(!!a.favorite) ||
      contactLabel(a).localeCompare(contactLabel(b), 'de'),
  );
  const all = contacts.length > 1 && selected.length === contacts.length;
  const toggle = (key: string) => onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  return (
    <View style={{ gap: spacing.sm }} accessibilityLabel={label}>
      <Wrap>
        {sorted.map((c) => (
          <Chip
            key={c.key}
            label={contactLabel(c)}
            icon={c.emergency ? '🆘' : c.favorite ? '⭐' : undefined}
            selected={selected.includes(c.key)}
            onPress={() => toggle(c.key)}
          />
        ))}
      </Wrap>
      {contacts.length > 2 && (
        <Row>
          <Button
            title={all ? 'Keinen auswählen' : 'Alle auswählen'}
            kind="ghost"
            compact
            onPress={() => onChange(all ? [] : contacts.map((c) => c.key))}
          />
        </Row>
      )}
      {selected.length === 0 && <T variant="small">Wähle mindestens eine Person.</T>}
    </View>
  );
}
