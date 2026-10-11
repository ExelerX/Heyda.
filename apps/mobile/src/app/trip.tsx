import type { SessionLevel } from '@heyda/core';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Button, Chip, Hint, Row, Screen, Section, T, Wrap } from '../components/ui';
import { LEVEL_TEXT } from '../lib/format';
import { locationSupported, requestLocationAccess } from '../lib/location';
import { useRuntime, useSnapshot } from '../lib/store';
import { radius, spacing, useTheme } from '../lib/theme';

const DURATIONS = [
  { label: '1 h', ms: 3600_000 },
  { label: '2 h', ms: 2 * 3600_000 },
  { label: '4 h', ms: 4 * 3600_000 },
];
const LEVELS: SessionLevel[] = ['eta', 'coarse', 'precise'];
const OTHER = '__other__';

export default function StartTrip() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, isDemo } = useSnapshot();
  const [recipients, setRecipients] = useState<string[]>(state.contacts.length === 1 ? [state.contacts[0]!.key] : []);
  const [placeId, setPlaceId] = useState<string>(state.places[0]?.id ?? OTHER);
  const [otherName, setOtherName] = useState('');
  const [level, setLevel] = useState<SessionLevel>('eta');
  const [duration, setDuration] = useState(DURATIONS[1]!.ms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const place = state.places.find((p) => p.id === placeId);
  const destinationName = place ? place.name : otherName.trim();
  const ready = recipients.length > 0 && destinationName.length > 0;

  const toggle = (key: string) =>
    setRecipients((r) => (r.includes(key) ? r.filter((k) => k !== key) : [...r, key]));

  async function start() {
    setBusy(true);
    setError(undefined);
    try {
      if (locationSupported && !isDemo) {
        const access = await requestLocationAccess();
        if (access === 'denied') {
          setError('Ohne Standortzugriff kann die App keine Ankunftszeit berechnen. Du kannst ihn in den Einstellungen erlauben.');
          return;
        }
      }
      await runtime.startTrip({
        recipients,
        destinationName,
        destination: place?.center,
        level,
        durationMs: duration,
      });
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen edges={['bottom']}>
      <Section title="Mit wem?">
        <Wrap>
          {state.contacts.map((c) => (
            <Chip key={c.key} label={c.name} selected={recipients.includes(c.key)} onPress={() => toggle(c.key)} />
          ))}
        </Wrap>
      </Section>

      <Section title="Wohin?">
        <Wrap>
          {state.places.map((p) => (
            <Chip key={p.id} label={p.name} icon="📍" selected={placeId === p.id} onPress={() => setPlaceId(p.id)} />
          ))}
          <Chip label="Anderes Ziel" icon="✏️" selected={placeId === OTHER} onPress={() => setPlaceId(OTHER)} />
        </Wrap>
        {placeId === OTHER && (
          <>
            <TextInput
              value={otherName}
              onChangeText={setOtherName}
              placeholder="z. B. Kino"
              placeholderTextColor={t.textMuted}
              maxLength={60}
              accessibilityLabel="Name des Ziels"
              style={{
                backgroundColor: t.surface,
                borderColor: t.border,
                borderWidth: 1,
                borderRadius: radius.md,
                color: t.text,
                fontSize: 16,
                padding: spacing.md,
              }}
            />
            <Hint>Für eine Ankunftszeit braucht die App einen gespeicherten Ort. Ohne sehen Freunde nur „unterwegs“.</Hint>
          </>
        )}
      </Section>

      <Section title="Was sehen sie?">
        {LEVELS.map((l) => (
          <Pressable
            key={l}
            onPress={() => setLevel(l)}
            accessibilityRole="radio"
            accessibilityState={{ checked: level === l }}
            style={{
              borderWidth: 1,
              borderColor: level === l ? t.accent : t.border,
              backgroundColor: t.surface,
              borderRadius: radius.md,
              padding: spacing.md,
              gap: 2,
            }}
          >
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="h2">{LEVEL_TEXT[l].title}</T>
              <T color={level === l ? t.accent : t.textMuted}>{level === l ? '●' : '○'}</T>
            </Row>
            <T variant="small">{LEVEL_TEXT[l].detail}</T>
          </Pressable>
        ))}
      </Section>

      <Section title="Höchstens wie lange?">
        <Wrap>
          {DURATIONS.map((d) => (
            <Chip key={d.ms} label={d.label} selected={duration === d.ms} onPress={() => setDuration(d.ms)} />
          ))}
        </Wrap>
        {level === 'precise' && duration > 2 * 3600_000 && (
          <T variant="small">Genauer Standort endet trotzdem nach 2 Stunden.</T>
        )}
      </Section>

      <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
        {error && <T color={t.danger}>{error}</T>}
        <Button title="Teilen starten" icon="🚗" onPress={() => void start()} disabled={!ready} busy={busy} />
        <T variant="small" style={{ textAlign: 'center' }}>
          Endet automatisch bei Ankunft oder nach der gewählten Zeit.
        </T>
      </View>
    </Screen>
  );
}
