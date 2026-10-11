import { MAX_WATCH_MS, MIN_WATCH_MS, type MyWatch } from '@heyda/core';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { BigButton } from '../components/safety/BigButton';
import { ContactPicker, defaultRecipients, namesOf, NoContacts, stillContacts } from '../components/safety/ContactPicker';
import { Field } from '../components/safety/Field';
import { Stepper } from '../components/safety/Stepper';
import { clockWithDay, countdown, spanText } from '../components/safety/time';
import { Button, Card, Chip, Hint, Pill, Row, Screen, Section, T, Wrap } from '../components/ui';
import { confirm, notice } from '../lib/confirm';
import { isDesktop } from '../lib/platform';
import { useRuntime, useSnapshot, useTick } from '../lib/store';
import { spacing, useTheme } from '../lib/theme';

const MIN = 60_000;
const LABELS = [
  { icon: '🚶', text: 'Heimweg' },
  { icon: '❤️', text: 'Date' },
  { icon: '🥾', text: 'Wanderung' },
  { icon: '🏃', text: 'Joggen' },
  { icon: '🚗', text: 'Autofahrt' },
  { icon: '🎉', text: 'Party' },
];
const DUE = [
  { label: '15 Min.', min: 15 },
  { label: '30 Min.', min: 30 },
  { label: '1 Std.', min: 60 },
  { label: '2 Std.', min: 120 },
  { label: '4 Std.', min: 240 },
];
const CUSTOM = -1;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "Pass auf mich auf": if I don't check in by a time, the chosen people get an alarm. */
export default function WatchScreen() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state } = useSnapshot();
  const now = useTick(1000);
  const [label, setLabel] = useState('');
  const [due, setDue] = useState(60);
  const [hours, setHours] = useState(1);
  const [minutes, setMinutes] = useState(30);
  const [recipients, setRecipients] = useState<string[]>(() => defaultRecipients(state.contacts));
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<string>();

  const watches = [...state.watches].sort((a, b) => a.dueAt - b.dueAt);
  const to = stillContacts(recipients, state.contacts);
  const totalMin = due === CUSTOM ? hours * 60 + minutes : due;
  const tooShort = totalMin * MIN < MIN_WATCH_MS;
  const tooLong = totalMin * MIN > MAX_WATCH_MS;
  const dueAt = now + totalMin * MIN;
  const ready = to.length > 0 && !tooShort && !tooLong && !busy;

  async function start() {
    if (!ready) return;
    setBusy(true);
    setStarted(undefined);
    try {
      const at = Date.now() + totalMin * MIN;
      const name = label.trim() || 'Unterwegs';
      await runtime.node.startWatch({ to, label: name, dueAt: at });
      setStarted(
        `„${name}“ läuft. Wenn du dich bis ${clockWithDay(at)} Uhr nicht meldest, ${to.length === 1 ? 'bekommt' : 'bekommen'} ${namesOf(to, state.contacts)} einen Alarm.`,
      );
      setLabel('');
    } catch (e) {
      notice('Nicht gestartet', errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen edges={['bottom']}>
      <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', gap: spacing.md }}>
        <Card style={{ gap: spacing.xs }}>
          <T>Du sagst, bis wann du dich meldest – zum Beispiel, wenn du nachts nach Hause gehst.</T>
          <T variant="muted">
            Meldest du dich bis dahin nicht, bekommen die gewählten Personen einen Alarm, auch in ihrem Ruhemodus.
          </T>
        </Card>

        {watches.length > 0 && (
          <Section title={watches.length === 1 ? 'Läuft gerade' : `${watches.length} laufen gerade`}>
            {watches.map((w) => (
              <WatchCard key={w.watchId} watch={w} now={now} />
            ))}
          </Section>
        )}

        {state.contacts.length === 0 ? (
          <NoContacts text="Damit jemand auf dich aufpassen kann, füge zuerst Freunde oder Familie hinzu." />
        ) : (
          <>
            <Section title={watches.length ? 'Noch eins starten' : 'Wofür?'}>
              <Wrap>
                {LABELS.map((l) => (
                  <Chip key={l.text} icon={l.icon} label={l.text} selected={label.trim() === l.text} onPress={() => setLabel(l.text)} />
                ))}
              </Wrap>
              <Field
                value={label}
                onChangeText={setLabel}
                placeholder="oder selbst schreiben, z. B. Konzert"
                maxLength={60}
                accessibilityLabel="Wofür"
              />
            </Section>

            <Section title="Bis wann meldest du dich?">
              <Wrap>
                {DUE.map((d) => (
                  <Chip key={d.min} label={d.label} selected={due === d.min} onPress={() => setDue(d.min)} />
                ))}
                <Chip label="Eigene Zeit" icon="✏️" selected={due === CUSTOM} onPress={() => setDue(CUSTOM)} />
              </Wrap>
              {due === CUSTOM && (
                <Card>
                  <Row style={{ alignItems: 'flex-start' }}>
                    <Stepper label="Stunden" unit="Std." value={hours} onChange={setHours} min={0} max={48} />
                    <Stepper label="Minuten" unit="Min." value={minutes} onChange={setMinutes} min={0} max={55} step={5} />
                  </Row>
                  {tooShort && <T color={t.danger}>Mindestens 5 Minuten.</T>}
                  {tooLong && <T color={t.danger}>Höchstens 48 Stunden.</T>}
                </Card>
              )}
              {!tooShort && !tooLong && (
                <T variant="muted">
                  Du meldest dich bis <T style={{ fontWeight: '800' }}>{clockWithDay(dueAt, now)} Uhr</T> (in {spanText(totalMin * MIN)}).
                </T>
              )}
            </Section>

            <Section title="Wer passt auf?">
              <ContactPicker contacts={state.contacts} selected={to} onChange={setRecipients} label="Wer passt auf" />
            </Section>

            <View style={{ marginTop: spacing.lg, gap: spacing.md }}>
              {started && (
                <Card style={{ borderColor: t.success }}>
                  <T color={t.success}>✓ {started}</T>
                </Card>
              )}
              <BigButton
                title="Pass auf mich auf starten"
                icon="🛡️"
                onPress={() => void start()}
                disabled={!ready}
                busy={busy}
              />
              <Hint>
                10 Minuten vorher erinnert dich dein {isDesktop ? 'Computer' : 'Handy'}. Melden kannst du dich hier oder mit „Kurz
                melden“ (z. B. „Gut angekommen“).
                {Platform.OS === 'ios'
                  ? ' Die Alarme sind auf den Geräten der anderen geplant und klingeln pünktlich, auch wenn dein iPhone aus ist.'
                  : ' Der Alarm ist auf den Geräten der anderen geplant und kommt auch, wenn dein Handy aus ist oder kein Netz hat.'}
              </Hint>
              <Button title="Mein Notruf (SOS)" icon="🆘" kind="ghost" compact onPress={() => router.push('/sos')} />
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}

function WatchCard({ watch: w, now }: { watch: MyWatch; now: number }) {
  const t = useTheme();
  const runtime = useRuntime();
  const { state } = useSnapshot();
  const [busy, setBusy] = useState<string>();
  const left = w.dueAt - now;
  const overdue = left <= 0;
  const names = namesOf(w.recipients, state.contacts, 'jemand');

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      notice('Das hat nicht geklappt', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  const extend = (ms: number) =>
    run(`+${ms}`, () => {
      const current = Date.now();
      const next = Math.min(Math.max(w.dueAt, current) + ms, current + MAX_WATCH_MS - MIN);
      return runtime.node.extendWatch(w.watchId, Math.max(next, current + MIN_WATCH_MS + MIN));
    });

  async function cancel() {
    const ok = await confirm({
      title: `„${w.label}“ abbrechen?`,
      message: `Dann passt niemand mehr auf. ${names} ${w.recipients.length === 1 ? 'bekommt' : 'bekommen'} keinen Alarm.`,
      ok: 'Abbrechen',
      cancel: 'Weiterlaufen lassen',
      destructive: true,
    });
    if (ok) await run('cancel', () => runtime.node.endWatch(w.watchId, 'cancelled'));
  }

  return (
    <Card style={{ borderColor: overdue ? t.danger : t.accent, borderWidth: overdue ? 2 : 1, gap: spacing.md }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="h2" style={{ flex: 1 }}>
          🛡️ {w.label}
        </T>
        {overdue ? <Pill text="Zeit abgelaufen" color={t.danger} /> : <Pill text="läuft" color={t.accent} />}
      </Row>
      {overdue ? (
        <View style={{ gap: spacing.xs }} accessibilityLiveRegion="polite">
          <Text style={{ color: t.danger, fontSize: 26, fontWeight: '900' }}>⏰ Seit {spanText(-left)} überfällig</Text>
          <T>
            {names} {w.recipients.length === 1 ? 'wurde' : 'wurden'} alarmiert. Melde dich jetzt, wenn alles okay ist!
          </T>
        </View>
      ) : (
        <View style={{ gap: 2 }}>
          <Text
            style={{ color: t.text, fontSize: 40, fontWeight: '900', fontVariant: ['tabular-nums'] }}
            accessibilityLabel={`noch ${spanText(left)}`}
          >
            {countdown(left)}
          </Text>
          <T variant="muted">
            Melde dich bis {clockWithDay(w.dueAt, now)} Uhr · {names} {w.recipients.length === 1 ? 'passt' : 'passen'} auf
          </T>
        </View>
      )}
      <BigButton
        kind="safe"
        icon="✅"
        title="Ich bin gut angekommen"
        busy={busy === 'ok'}
        disabled={!!busy && busy !== 'ok'}
        onPress={() => void run('ok', () => runtime.node.endWatch(w.watchId, 'ok'))}
      />
      <Row style={{ flexWrap: 'wrap' }}>
        <Button title="+15 Min." kind="secondary" compact busy={busy === `+${15 * MIN}`} disabled={!!busy} onPress={() => void extend(15 * MIN)} />
        <Button title="+1 Std." kind="secondary" compact busy={busy === `+${60 * MIN}`} disabled={!!busy} onPress={() => void extend(60 * MIN)} />
        <View style={{ flex: 1 }} />
        <Button title="Abbrechen" kind="ghost" compact busy={busy === 'cancel'} disabled={!!busy} onPress={() => void cancel()} />
      </Row>
    </Card>
  );
}
