import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Platform, View } from 'react-native';
import { Avatar, Button, Card, Chip, Pill, Row, Screen, Section, T, Wrap } from '../../components/ui';
import { useRuntime, useSnapshot } from '../../lib/store';
import { spacing, useTheme } from '../../lib/theme';

export default function ContactDetails() {
  const t = useTheme();
  const { key } = useLocalSearchParams<{ key: string }>();
  const runtime = useRuntime();
  const { state } = useSnapshot();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const contact = state.contacts.find((c) => c.key === key);

  if (!contact) {
    return (
      <Screen edges={['bottom']}>
        <T variant="muted">Diesen Kontakt gibt es nicht mehr.</T>
      </Screen>
    );
  }

  const granted = state.grants.find((g) => g.contactKey === contact.key)?.placeIds ?? [];
  const toggleGrant = (placeId: string) =>
    runtime.setPlaceGrant(
      contact.key,
      granted.includes(placeId) ? granted.filter((p) => p !== placeId) : [...granted, placeId],
    );

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: contact.name }} />
      <Row gap={spacing.lg}>
        <Avatar name={contact.name} keyHex={contact.key} size={64} />
        <View style={{ flex: 1, gap: 4 }}>
          <T variant="big">{contact.name}</T>
          {contact.verified ? <Pill text="✓ verifiziert" color={t.success} /> : <Pill text="nicht verifiziert" color={t.textMuted} />}
        </View>
      </Row>

      <Section title="Sicherheitsnummer">
        <Card style={{ alignItems: 'center' }}>
          <T style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 20, letterSpacing: 2, textAlign: 'center' }}>
            {runtime.safetyNumberWith(contact.key)}
          </T>
        </Card>
        <T variant="small">
          Vergleicht die Zahlen, wenn ihr euch seht oder telefoniert. Stimmen sie auf beiden Handys überein, liest niemand mit.
        </T>
        {!contact.verified && (
          <Button title="Stimmt überein" icon="✅" kind="secondary" onPress={() => runtime.markVerified(contact.key)} />
        )}
      </Section>

      <Section title={`Was ${contact.name} von dir sieht`}>
        <T variant="muted">
          Ankunftszeiten nur, wenn du das Teilen startest. Ankunft und Abfahrt nur an diesen Orten:
        </T>
        {state.places.length ? (
          <Wrap>
            {state.places.map((p) => (
              <Chip key={p.id} label={p.name} icon="📍" selected={granted.includes(p.id)} onPress={() => toggleGrant(p.id)} />
            ))}
          </Wrap>
        ) : (
          <Button title="Orte anlegen" kind="secondary" onPress={() => router.push('/places')} />
        )}
      </Section>

      <Section title="Kontakt entfernen">
        {confirmRemove ? (
          <>
            <T variant="muted">
              {contact.name} bekommt dann nichts mehr von dir, und euer Chat wird auf diesem Handy gelöscht.
            </T>
            <Button
              title="Ja, entfernen"
              kind="danger"
              onPress={() => {
                runtime.removeContact(contact.key);
                router.replace('/');
              }}
            />
            <Button title="Abbrechen" kind="ghost" onPress={() => setConfirmRemove(false)} />
          </>
        ) : (
          <Button title="Entfernen" kind="danger" onPress={() => setConfirmRemove(true)} />
        )}
      </Section>
    </Screen>
  );
}
