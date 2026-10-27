import { contactLabel, type Contact } from '@heyda/core';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { NoContacts } from '../components/safety/ContactPicker';
import { Field } from '../components/safety/Field';
import { checkPhone } from '../components/safety/phone';
import { Avatar, Button, Card, Hint, Row, Screen, Section, T, Toggle } from '../components/ui';
import { notice } from '../lib/confirm';
import { isNative } from '../lib/platform';
import { useRuntime, useSnapshot } from '../lib/store';
import { spacing, useTheme } from '../lib/theme';

const STEPS = [
  'Du hältst den roten SOS-Knopf 2 Sekunden lang gedrückt. Kurzes Antippen löst nichts aus.',
  'Deine Notfallkontakte bekommen sofort einen lauten Alarm, auch wenn ihr Handy im Ruhemodus ist.',
  'Dein genauer Standort geht mit, auch im Geistmodus, und wird eine Stunde lang aktualisiert.',
  'Sie können antworten: „Ich kümmere mich“. Das siehst du sofort, die anderen Helfer auch.',
  'Zusätzlich kannst du eine SMS mit deinem Standort schicken und jederzeit die 112 anrufen.',
  'Mit „Ich bin in Sicherheit“ oder „Fehlalarm“ beendest du den Notruf für alle.',
];

/** Who gets my SOS, their phone numbers for the SMS fallback, my default message. */
export default function SafetyScreen() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, settings, isDemo } = useSnapshot();
  const emergency = state.contacts.filter((c) => c.emergency);
  const sorted = [...state.contacts].sort((a, b) => contactLabel(a).localeCompare(contactLabel(b), 'de'));

  return (
    <Screen edges={['bottom']}>
      <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', gap: spacing.md }}>
        <Card style={{ gap: spacing.xs }}>
          <T>Wenn du SOS auslöst, bekommen deine Notfallkontakte sofort einen Alarm mit deinem genauen Standort.</T>
          <T variant="small">Wähle Menschen, die schnell reagieren können und in deiner Nähe wohnen.</T>
        </Card>

        <Section title="Notfallkontakte">
          {state.contacts.length === 0 ? (
            <NoContacts text="Notfallkontakte wählst du aus deinen Kontakten. Füge zuerst jemanden hinzu." />
          ) : (
            <>
              {emergency.length === 0 && (
                <Card style={{ borderColor: t.danger }}>
                  <T color={t.danger} style={{ fontWeight: '700' }}>
                    ⚠️ Noch niemand ausgewählt
                  </T>
                  <T variant="small">Ohne Notfallkontakte musst du im Notfall erst auswählen, wer den Alarm bekommt.</T>
                </Card>
              )}
              <Card>
                {sorted.map((c) => (
                  <Row key={c.key} gap={spacing.md}>
                    <Avatar name={contactLabel(c)} keyHex={c.key} size={36} />
                    <View style={{ flex: 1 }}>
                      <Toggle
                        label={contactLabel(c)}
                        detail={c.emergency ? (c.phone ? `🆘 Notfallkontakt · 📱 ${c.phone}` : '🆘 Notfallkontakt') : undefined}
                        value={!!c.emergency}
                        onChange={(v) => runtime.node.updateContact(c.key, { emergency: v })}
                      />
                    </View>
                  </Row>
                ))}
              </Card>
              <T variant="small">
                {emergency.length === 1
                  ? '1 Person bekommt deinen Notruf.'
                  : emergency.length > 1
                    ? `${emergency.length} Personen bekommen deinen Notruf.`
                    : ''}{' '}
                Sie erfahren davon erst, wenn du SOS auslöst.
              </T>
            </>
          )}
        </Section>

        <Section title="SMS als Rückfall">
          <Card style={{ gap: spacing.md }}>
            <Toggle
              label="Nach einem SOS auch SMS anbieten"
              detail="Für alle, die gerade kein Internet haben. Dein Handy öffnet eine fertige SMS mit deinem Standort, du drückst selbst auf Senden. Es kostet eine normale SMS."
              value={settings.smsFallback}
              onChange={(v) => runtime.updateSettings({ smsFallback: v })}
            />
            {!isNative && <T variant="small">SMS gehen nur vom Handy aus. Am Computer wird keine SMS angeboten.</T>}
            {settings.smsFallback && emergency.length > 0 && (
              <View style={{ gap: spacing.md }}>
                <T variant="h2">Telefonnummern</T>
                <T variant="small">Am besten mit Ländervorwahl, z. B. +49 170 1234567. Die Nummern bleiben auf deinen Geräten.</T>
                {emergency.map((c) => (
                  <PhoneRow key={c.key} contact={c} />
                ))}
              </View>
            )}
          </Card>
        </Section>

        <Section title="Standard-Nachricht">
          <SosMessage />
        </Section>

        <Section title="SOS testen?">
          <Card style={{ gap: spacing.md }}>
            <T variant="h2">So läuft ein Notruf ab</T>
            {STEPS.map((s, i) => (
              <Row key={s} style={{ alignItems: 'flex-start' }} gap={spacing.md}>
                <View
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    backgroundColor: t.surfaceRaised,
                    borderWidth: 1,
                    borderColor: t.border,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: t.text, fontWeight: '800', fontSize: 13 }}>{i + 1}</Text>
                </View>
                <T style={{ flex: 1 }}>{s}</T>
              </Row>
            ))}
            <Hint>
              Einen Test-Alarm gibt es absichtlich nicht, damit niemand umsonst erschrickt. Sag deinen Notfallkontakten lieber
              persönlich, dass du sie eingetragen hast, und bitte sie, Heyda. Benachrichtigungen zu erlauben.
            </Hint>
            {isDemo && (
              <>
                <T variant="small">Im Demo-Modus kannst du es gefahrlos ausprobieren: Der Alarm geht nur an die Demo-Freunde.</T>
                <Button title="Notruf-Bildschirm öffnen" icon="🆘" kind="danger" onPress={() => router.push('/sos')} />
              </>
            )}
          </Card>
        </Section>

        <Card onPress={() => router.push('/quiet')} label="Ruhe und Benachrichtigungen: Damit Alarme bei dir zuverlässig klingeln">
          <Row gap={spacing.md}>
            <Text accessible={false} style={{ fontSize: 24 }}>
              🔔
            </Text>
            <View style={{ flex: 1 }}>
              <T style={{ fontWeight: '700' }}>Damit Alarme bei dir zuverlässig klingeln</T>
              <T variant="small">Ruhe & Benachrichtigungen</T>
            </View>
            <T color={t.textMuted}>›</T>
          </Row>
        </Card>
      </View>
    </Screen>
  );
}

function PhoneRow({ contact }: { contact: Contact }) {
  const t = useTheme();
  const runtime = useRuntime();
  const [text, setText] = useState(contact.phone ?? '');
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const id = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(id);
  }, [saved]);

  const commit = () => {
    const r = checkPhone(text);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(undefined);
    if ((r.value ?? undefined) === (contact.phone ?? undefined)) return;
    runtime.node.updateContact(contact.key, { phone: r.value });
    setSaved(true);
  };

  const name = contactLabel(contact);
  return (
    <View style={{ gap: spacing.xs }}>
      <Row style={{ alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}>
          <Field
            label={name}
            value={text}
            onChangeText={(v) => {
              setText(v);
              setError(undefined);
            }}
            onBlur={commit}
            onSubmitEditing={commit}
            placeholder="+49 170 1234567"
            keyboardType="phone-pad"
            maxLength={24}
            error={error}
            accessibilityLabel={`Telefonnummer von ${name}`}
            returnKeyType="done"
          />
        </View>
        {!error && (
          <Button title="Speichern" kind="secondary" compact onPress={commit} />
        )}
      </Row>
      {saved && (
        <T variant="small" color={t.success}>
          ✓ Gespeichert
        </T>
      )}
      {!contact.phone && !text.trim() && <T variant="small">Ohne Nummer bekommt {name} keine SMS.</T>}
    </View>
  );
}

function SosMessage() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state } = useSnapshot();
  const [text, setText] = useState(state.sosMessage ?? '');
  const [saved, setSaved] = useState(false);
  const changed = text.trim() !== (state.sosMessage ?? '');

  const save = () => {
    try {
      runtime.node.setSosMessage(text.trim() || undefined);
      setText(text.trim());
      setSaved(true);
    } catch (e) {
      notice('Nicht gespeichert', e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card style={{ gap: spacing.md }}>
      <Field
        value={text}
        onChangeText={(v) => {
          setText(v);
          setSaved(false);
        }}
        placeholder="z. B. Ich brauche Hilfe, bitte ruf mich an!"
        maxLength={200}
        multiline
        counter
        accessibilityLabel="Standard-Nachricht für einen Notruf"
        hint="Steht schon im Notruf, wenn du ihn auslöst. Du kannst sie dann noch ändern."
      />
      <Row>
        <Button title="Speichern" compact disabled={!changed} onPress={save} />
        {saved && !changed && (
          <T variant="small" color={t.success}>
            ✓ Gespeichert
          </T>
        )}
      </Row>
    </Card>
  );
}
