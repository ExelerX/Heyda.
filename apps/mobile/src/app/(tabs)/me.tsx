import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { Avatar, Button, Card, Chip, Pill, Row, Screen, Section, T, Toggle, Wrap } from '../../components/ui';
import { currentLocationAccess, locationSupported, requestLocationAccess, type LocationAccess } from '../../lib/location';
import { useRestart, useRuntime, useSnapshot } from '../../lib/store';
import { radius, spacing, useTheme, type Appearance } from '../../lib/theme';

const ACCESS_TEXT: Record<LocationAccess, string> = {
  always: 'Immer erlaubt: Ankunft und „gleich da“ klappen auch bei geschlossener App.',
  'while-using': 'Nur bei geöffneter App. Ankunft an deinen Orten wird dann nicht erkannt.',
  denied: 'Nicht erlaubt. Ankunftszeiten und Orte funktionieren nicht.',
};

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: 'dark', label: 'Dunkel' },
  { value: 'light', label: 'Hell' },
  { value: 'system', label: 'Wie System' },
];

export default function Me() {
  const t = useTheme();
  const runtime = useRuntime();
  const restart = useRestart();
  const { state, settings, isDemo } = useSnapshot();
  const [name, setName] = useState(state.self.name);
  const [access, setAccess] = useState<LocationAccess>();
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [switching, setSwitching] = useState(false);
  const web = Platform.OS === 'web';

  useEffect(() => {
    if (locationSupported && !isDemo) void currentLocationAccess().then(setAccess);
  }, [isDemo]);

  async function switchDemo(demo: boolean) {
    setSwitching(true);
    await runtime.setDemo(demo);
    await restart();
  }

  async function wipe() {
    await runtime.wipeEverything();
    await restart();
  }

  return (
    <Screen title="Ich">
      <Card>
        <Row gap={spacing.md}>
          <Avatar name={state.self.name} keyHex={state.self.key} size={56} />
          <View style={{ flex: 1, gap: 4 }}>
            <TextInput
              value={name}
              onChangeText={setName}
              onEndEditing={() => name.trim() !== state.self.name && void runtime.setDisplayName(name)}
              maxLength={40}
              accessibilityLabel="Dein Name"
              style={{ color: t.text, fontSize: 22, fontWeight: '800', padding: 0 }}
            />
            <T variant="small">So sehen dich deine Kontakte. Tippe zum Ändern.</T>
          </View>
        </Row>
      </Card>

      <Section title="Kontakte" action={<Button title="+ Hinzufügen" kind="ghost" compact onPress={() => router.push('/pair')} />}>
        {state.contacts.length === 0 && <T variant="muted">Noch niemand. Scannt gegenseitig eure QR-Codes.</T>}
        {state.contacts.map((c) => (
          <Card key={c.key} onPress={() => router.push(`/contact/${c.key}`)} label={c.name}>
            <Row gap={spacing.md}>
              <Avatar name={c.name} keyHex={c.key} size={36} />
              <T variant="h2" style={{ flex: 1 }}>
                {c.name}
              </T>
              {c.verified ? <Pill text="✓ verifiziert" color={t.success} /> : <Pill text="prüfen" color={t.textMuted} />}
            </Row>
          </Card>
        ))}
      </Section>

      <Section title="Privatsphäre">
        <Card>
          <Toggle
            label="Geistermodus"
            detail="Pausiert alle Ankunftszeiten und Orts-Hinweise auf einmal."
            value={state.ghost}
            onChange={(v) => runtime.setGhost(v)}
          />
        </Card>
        <Card onPress={() => router.push('/places')} label="Meine Orte">
          <Row style={{ justifyContent: 'space-between' }}>
            <T variant="h2">📍 Meine Orte</T>
            <T variant="small">{state.places.length}</T>
          </Row>
          <T variant="small">Wer bei welchem Ort Ankunft und Abfahrt sieht.</T>
        </Card>
        {access && (
          <Card>
            <T variant="h2">Standortzugriff</T>
            <T variant="small">{ACCESS_TEXT[access]}</T>
            {access !== 'always' && (
              <Button title="Zugriff ändern" kind="secondary" compact onPress={() => void requestLocationAccess().then(setAccess)} />
            )}
          </Card>
        )}
        <Card>
          <T variant="h2">🔒 Was die App weitergibt</T>
          <T variant="small">
            Nur verschlüsselte Nachrichten an deine Kontakte, über öffentliche Nostr-Relays. Die Relays sehen nicht, was
            drinsteht oder wer schreibt, aber an welche Kennung (ein Pseudonym, kein Name) und wann. Keine Werbung, kein Tracking, kein Konto.
          </T>
        </Card>
      </Section>

      <Section title="Design">
        <Wrap>
          {APPEARANCES.map((a) => (
            <Chip
              key={a.value}
              label={a.label}
              selected={(settings.appearance ?? 'dark') === a.value}
              onPress={() => runtime.setAppearance(a.value)}
            />
          ))}
        </Wrap>
      </Section>

      {!web && (
        <Section title="Demo">
          <Card>
            <Toggle
              label="Demo-Modus"
              detail="Zwei simulierte Freunde zum Ausprobieren. Nichts verlässt dein Handy, echte Kontakte sind solange nicht erreichbar."
              value={isDemo}
              onChange={(v) => void switchDemo(v)}
            />
            {switching && <T variant="small">Wird umgeschaltet…</T>}
          </Card>
        </Section>
      )}

      <Section title="Über">
        <Card>
          <T variant="small">Open Source unter der Apache-2.0-Lizenz. Kostenlos, ohne Werbung.</T>
          <T variant="small">Deine Kennung: {state.self.key.slice(0, 8)}…{state.self.key.slice(-8)}</T>
          <T variant="small">Relays: {state.self.relays.length ? state.self.relays.join(', ') : 'keine (Demo)'}</T>
        </Card>
      </Section>

      <Section title="Alle Daten löschen">
        {confirmWipe ? (
          <View style={{ gap: spacing.sm, borderRadius: radius.md }}>
            <T variant="muted">
              Löscht Kontakte, Chats, Orte, Automationen und deine Schlüssel von diesem Handy. Das lässt sich nicht
              rückgängig machen.
            </T>
            <Button title="Ja, alles löschen" kind="danger" onPress={() => void wipe()} />
            <Button title="Abbrechen" kind="ghost" onPress={() => setConfirmWipe(false)} />
          </View>
        ) : (
          <Button title="Alles löschen" kind="danger" onPress={() => setConfirmWipe(true)} />
        )}
      </Section>
    </Screen>
  );
}
