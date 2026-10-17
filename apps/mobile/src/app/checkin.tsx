import { CHECKIN_LABELS, checkinText, type CheckinKind } from '@heyda/core';
import { router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BigButton } from '../components/safety/BigButton';
import { ContactPicker, defaultRecipients, namesOf, NoContacts, stillContacts } from '../components/safety/ContactPicker';
import { Field } from '../components/safety/Field';
import { Card, Hint, Row, Screen, Section, T, Toggle } from '../components/ui';
import { notice } from '../lib/confirm';
import { useRuntime, useSnapshot } from '../lib/store';
import { radius, spacing, TOUCH, useTheme } from '../lib/theme';

interface Preset {
  id: string;
  kind: CheckinKind;
  icon: string;
  label: string;
  vacation?: boolean;
}

const PRESETS: Preset[] = [
  { id: 'arrived', kind: 'arrived', icon: CHECKIN_LABELS.arrived.emoji, label: CHECKIN_LABELS.arrived.text },
  { id: 'home', kind: 'home', icon: CHECKIN_LABELS.home.emoji, label: CHECKIN_LABELS.home.text },
  { id: 'vacation', kind: 'arrived', icon: '🏖️', label: 'Im Urlaub angekommen', vacation: true },
  { id: 'ok', kind: 'ok', icon: CHECKIN_LABELS.ok.emoji, label: CHECKIN_LABELS.ok.text },
  { id: 'custom', kind: 'custom', icon: CHECKIN_LABELS.custom.emoji, label: 'Eigene Nachricht' },
];

const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

/** "Kurz melden": tell people I arrived or that all is fine. */
export default function CheckinScreen() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state } = useSnapshot();
  const [presetId, setPresetId] = useState('arrived');
  const [recipients, setRecipients] = useState<string[]>(() => defaultRecipients(state.contacts));
  const [text, setText] = useState('');
  const [place, setPlace] = useState('');
  const [placeOn, setPlaceOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string>();

  useEffect(() => {
    if (!sentTo) return;
    const id = setTimeout(close, 1800);
    return () => clearTimeout(id);
  }, [sentTo]);

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!;
  const to = stillContacts(recipients, state.contacts);
  const watches = state.watches;

  // What the message will say, exactly as the others will see it.
  const cleanPlace = place.trim();
  const cleanText = text.trim();
  const finalText = preset.vacation
    ? cleanText || (cleanPlace ? `Gut in ${cleanPlace} angekommen 🏖️` : 'Gut im Urlaub angekommen 🏖️')
    : cleanText || undefined;
  const typedPlace = preset.vacation ? (cleanText && cleanPlace ? cleanPlace : undefined) : cleanPlace || undefined;
  // The place I'm at, only if everyone it goes to may see it (and nothing was typed).
  const herePlace = cleanPlace ? undefined : runtime.node.checkinPlace(to);
  const finalPlace = typedPlace ?? (herePlace && placeOn ? herePlace : undefined);
  const preview = checkinText(preset.kind, finalText, finalPlace);
  const ready = to.length > 0 && !busy && (preset.kind !== 'custom' || cleanText.length > 0);

  async function send() {
    if (!ready) return;
    setBusy(true);
    try {
      // Exactly what the preview shows: no place is added behind its back.
      await runtime.node.sendCheckin({ to, kind: preset.kind, text: finalText, placeName: finalPlace, autoPlace: false });
      setSentTo(namesOf(to, state.contacts));
    } catch (e) {
      notice('Nicht gesendet', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: 'Kurz melden' }} />
        <Card style={{ alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl, width: '100%', maxWidth: 560, alignSelf: 'center' }}>
          <Text accessible={false} style={{ fontSize: 56 }}>
            ✅
          </Text>
          <T variant="big" style={{ textAlign: 'center' }}>
            Gesendet
          </T>
          <T variant="muted" style={{ textAlign: 'center' }} >
            {sentTo} {to.length === 1 ? 'weiß' : 'wissen'} jetzt Bescheid.
          </T>
          <BigButton title="Fertig" onPress={close} style={{ alignSelf: 'stretch' }} />
        </Card>
      </Screen>
    );
  }

  if (!state.contacts.length) {
    return (
      <Screen edges={['bottom']}>
        <NoContacts text="Damit du dich bei jemandem melden kannst, füge zuerst Freunde oder Familie hinzu." />
      </Screen>
    );
  }

  return (
    <Screen edges={['bottom']}>
      <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', gap: spacing.md }}>
        <Section title="Was möchtest du sagen?">
          <View style={{ gap: spacing.sm }} accessibilityRole="radiogroup">
            {PRESETS.map((p) => {
              const on = p.id === presetId;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => setPresetId(p.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={p.label}
                  style={({ pressed }) => ({
                    minHeight: TOUCH + 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.md,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.sm,
                    borderRadius: radius.md,
                    borderWidth: on ? 2 : 1,
                    borderColor: on ? t.accent : t.border,
                    backgroundColor: pressed ? t.surfaceRaised : t.surface,
                  })}
                >
                  <Text accessible={false} style={{ fontSize: 24 }}>
                    {p.icon}
                  </Text>
                  <T style={{ flex: 1, fontWeight: on ? '700' : '400' }}>{p.label}</T>
                  <T color={on ? t.accent : t.textMuted}>{on ? '●' : '○'}</T>
                </Pressable>
              );
            })}
          </View>
        </Section>

        <Section title={preset.vacation ? 'Wo bist du angekommen?' : 'Details (optional)'}>
          <Field
            label={preset.vacation ? 'Ort' : 'Ort (optional)'}
            value={place}
            onChangeText={setPlace}
            placeholder={preset.vacation ? 'z. B. Rom' : 'z. B. bei Oma'}
            maxLength={60}
            hint={
              preset.vacation
                ? undefined
                : 'Leer lassen: Bist du gerade an einem deiner Orte, kannst du ihn mitschicken – wenn alle, an die es geht, ihn sehen dürfen.'
            }
          />
          {herePlace ? (
            <Toggle
              label="Ort mitschicken"
              detail={`Du bist gerade hier: „${herePlace}“. Alle, an die es geht, dürfen diesen Ort sehen.`}
              value={placeOn}
              onChange={setPlaceOn}
            />
          ) : null}
          <Field
            label={preset.kind === 'custom' ? 'Deine Nachricht' : 'Nachricht (optional)'}
            value={text}
            onChangeText={setText}
            placeholder={preset.kind === 'custom' ? 'z. B. Zug hat Verspätung, alles gut' : preset.vacation ? 'z. B. Wetter traumhaft!' : 'z. B. Danke fürs Bringen!'}
            maxLength={140}
            multiline
            counter
          />
        </Section>

        <Section title="An wen?">
          <ContactPicker contacts={state.contacts} selected={to} onChange={setRecipients} />
        </Section>

        <Card style={{ marginTop: spacing.lg }}>
          <T variant="small">So sieht es aus:</T>
          <T variant="h2">{preview}</T>
        </Card>

        {watches.length > 0 &&
          (preset.kind === 'custom' ? (
            <Hint>Eine eigene Nachricht beendet dein „Pass auf mich auf“ nicht.</Hint>
          ) : (
            <Hint>
              Damit endet auch dein „Pass auf mich auf“ ({watches.map((w) => w.label).join(', ')}). Alle, die aufpassen, erfahren,
              dass alles okay ist.
            </Hint>
          ))}

        <Row style={{ marginTop: spacing.sm }}>
          <BigButton
            title={to.length ? `Senden an ${to.length === 1 ? namesOf(to, state.contacts) : `${to.length} Personen`}` : 'Senden'}
            icon={preset.icon}
            onPress={() => void send()}
            disabled={!ready}
            busy={busy}
            style={{ flex: 1 }}
          />
        </Row>
      </View>
    </Screen>
  );
}
