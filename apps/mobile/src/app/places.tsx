import { randomId } from '@social-app/core';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Button, Card, Chip, Empty, Hint, Row, Screen, Section, T, Wrap } from '../components/ui';
import { currentPosition, locationSupported, MAX_REGIONS, requestLocationAccess } from '../lib/location';
import { useRuntime, useSnapshot } from '../lib/store';
import { radius, spacing, TOUCH, useTheme } from '../lib/theme';

const RADII = [100, 200, 400];
const NAMES = ['Zuhause', 'Arbeit', 'Schule', 'Supermarkt', 'Sport'];
/** Demo places sit around a made-up spot; the real location is never used in demo mode. */
const DEMO_CENTER = { lat: 52.5208, lon: 13.4094 };

export default function Places() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, isDemo } = useSnapshot();
  const [name, setName] = useState('');
  const [radiusM, setRadiusM] = useState(RADII[0]!);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const full = state.places.length >= MAX_REGIONS;

  async function addHere() {
    setBusy(true);
    setMessage(undefined);
    try {
      let center = { lat: DEMO_CENTER.lat + state.places.length * 0.004, lon: DEMO_CENTER.lon };
      if (locationSupported && !isDemo) {
        const access = await requestLocationAccess();
        if (access === 'denied') {
          setMessage('Ohne Standortzugriff kann die App den Ort nicht speichern.');
          return;
        }
        if (access === 'while-using') {
          setMessage('Gespeichert. Für Ankunft und Abfahrt bei geschlossener App braucht es „Immer erlauben“.');
        }
        const pos = await currentPosition();
        center = { lat: pos.lat, lon: pos.lon };
      }
      runtime.savePlace({ id: randomId(10), name: name.trim(), center, radiusM });
      setName('');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen edges={['bottom']}>
      <Hint>Orte bleiben auf deinem Handy. Freunde, denen du einen Ort freigibst, sehen nur den Namen, nie die Koordinaten.</Hint>

      {state.places.length === 0 ? (
        <Empty icon="📍" title="Noch keine Orte" text="Speichere z. B. Zuhause oder die Arbeit, um Ankunft und Abfahrt zu teilen." />
      ) : (
        state.places.map((p) => {
          const viewers = state.contacts.filter((c) =>
            state.grants.some((g) => g.contactKey === c.key && g.placeIds.includes(p.id)),
          );
          return (
            <Card key={p.id}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T variant="h2">📍 {p.name}</T>
                <T variant="small">{p.radiusM} m</T>
              </Row>
              <T variant="small">Wer sieht Ankunft und Abfahrt hier?</T>
              <Wrap>
                {state.contacts.map((c) => {
                  const on = viewers.includes(c);
                  const current = state.grants.find((g) => g.contactKey === c.key)?.placeIds ?? [];
                  return (
                    <Chip
                      key={c.key}
                      label={c.name}
                      selected={on}
                      onPress={() =>
                        runtime.setPlaceGrant(c.key, on ? current.filter((id) => id !== p.id) : [...current, p.id])
                      }
                    />
                  );
                })}
                {!state.contacts.length && <T variant="small">Noch keine Kontakte.</T>}
              </Wrap>
              <Row style={{ justifyContent: 'flex-end' }}>
                <Pressable
                  onPress={() => runtime.removePlace(p.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${p.name} löschen`}
                  style={{ minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: spacing.sm }}
                >
                  <Text style={{ color: t.danger, fontWeight: '600' }}>Löschen</Text>
                </Pressable>
              </Row>
            </Card>
          );
        })
      )}

      <Section title="Neuer Ort an meiner Position">
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Name, z. B. Zuhause"
          placeholderTextColor={t.textMuted}
          maxLength={60}
          accessibilityLabel="Name des Ortes"
          style={{ backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: radius.md, color: t.text, fontSize: 16, padding: spacing.md }}
        />
        <Wrap>
          {NAMES.map((n) => (
            <Chip key={n} label={n} selected={name === n} onPress={() => setName(n)} />
          ))}
        </Wrap>
        <T variant="small">Größe</T>
        <Wrap>
          {RADII.map((r) => (
            <Chip key={r} label={`${r} m`} selected={radiusM === r} onPress={() => setRadiusM(r)} />
          ))}
        </Wrap>
        <View style={{ gap: spacing.sm }}>
          {message && <T variant="small" color={t.accent}>{message}</T>}
          <Button
            title={full ? `Höchstens ${MAX_REGIONS} Orte` : 'Hier speichern'}
            icon="📍"
            onPress={() => void addHere()}
            disabled={!name.trim() || full}
            busy={busy}
          />
        </View>
      </Section>
    </Screen>
  );
}
