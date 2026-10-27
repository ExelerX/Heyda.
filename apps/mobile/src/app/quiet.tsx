import { ALERT_CATEGORIES, type AlertCategory, type DndSettings, type NotificationPrefs } from '@heyda/core';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Platform, Text, View } from 'react-native';
import { Field } from '../components/safety/Field';
import { clockWithDay, inTime, untilSevenAm } from '../components/safety/time';
import { Button, Card, Chip, Hint, Row, Screen, Section, T, Toggle, Wrap } from '../components/ui';
import { notice } from '../lib/confirm';
import {
  isDndAccessGranted,
  isIgnoringBatteryOptimizations,
  keepAliveSupported,
  openBatteryOptimizationSettings,
} from '../lib/keepalive';
import { notificationsAllowed, setupNotifications } from '../lib/notifications';
import { autostartSupported, desktop, isBrowserPreview, isDesktop, isNative } from '../lib/platform';
import { useRuntime, useSnapshot, useTick } from '../lib/store';
import { spacing, useTheme } from '../lib/theme';

/** German names for every kind of notification. */
const CATEGORY_TEXT: Record<AlertCategory, { label: string; detail?: string }> = {
  sos: { label: 'Notrufe', detail: 'Immer an. Ein Notruf kommt immer durch.' },
  watch: { label: '„Pass auf mich auf“-Alarme', detail: 'Immer an. Im Ruhemodus gilt deine Einstellung oben.' },
  chat: { label: 'Nachrichten' },
  ping: { label: 'Kurznachrichten', detail: 'z. B. „Kannst du mich abholen?“' },
  group: { label: 'Gruppen' },
  checkin: { label: 'Check-ins', detail: '„Gut angekommen“, „Alles okay“ – und wer sich um einen Notruf kümmert' },
  arrival: { label: 'Ankommen & Losgehen', detail: 'an euren Orten und am Ziel' },
  trip: { label: 'Unterwegs', detail: 'Jemand teilt die Ankunftszeit oder startet „Pass auf mich auf“' },
  live: { label: 'Live-Standort', detail: 'Jemand beginnt, den Standort mit dir zu teilen' },
  where: { label: '„Wo bist du?“', detail: 'Fragen an dich und Antworten' },
  status: { label: 'Status', detail: 'z. B. „🎬 Im Kino“' },
  contact: { label: 'Neue Kontakte' },
  automation: { label: 'Automationen', detail: 'Hinweise deiner eigenen Regeln' },
  device: { label: 'Meine Geräte', detail: 'Ein neues Gerät nutzt dein Konto. Wichtig für deine Sicherheit.' },
};
const ALWAYS_ON: AlertCategory[] = ['sos', 'watch'];

const WEEKDAYS = [
  { day: 1, short: 'Mo', long: 'Montag' },
  { day: 2, short: 'Di', long: 'Dienstag' },
  { day: 3, short: 'Mi', long: 'Mittwoch' },
  { day: 4, short: 'Do', long: 'Donnerstag' },
  { day: 5, short: 'Fr', long: 'Freitag' },
  { day: 6, short: 'Sa', long: 'Samstag' },
  { day: 7, short: 'So', long: 'Sonntag' },
];

const URGENT: { value: DndSettings['urgentFrom']; label: string }[] = [
  { value: 'all', label: 'Alle' },
  { value: 'favorites', label: 'Nur Favoriten' },
  { value: 'none', label: 'Niemand' },
];

/** "22", "2200", "22.00" or "7:5" → "22:00"; undefined if it is not a time. */
function parseTime(input: string): string | undefined {
  const s = input.trim().replace('.', ':');
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(s);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Quiet mode, schedule, what may break through, per-category switches and delivery reliability. */
export default function QuietScreen() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, dndActive, dndEndsAt } = useSnapshot();
  const now = useTick(30_000);
  const prefs = state.prefs;
  const dnd = prefs.dnd;
  const manualOn = !!dnd.manual && (dnd.manual.until === undefined || dnd.manual.until > now);
  const seven = untilSevenAm(now);

  // Read the newest prefs at the moment of the change, so quick taps don't undo each other.
  const save = useCallback(
    (change: (p: NotificationPrefs) => NotificationPrefs) => {
      runtime.node.setPrefs(change(runtime.node.getState().prefs)).catch((e: unknown) => notice('Nicht gespeichert', errorText(e)));
    },
    [runtime],
  );
  const saveDnd = (patch: Partial<DndSettings>) => save((p) => ({ ...p, dnd: { ...p.dnd, ...patch } }));
  const saveSchedule = (patch: Partial<DndSettings['schedule']>) =>
    save((p) => ({ ...p, dnd: { ...p.dnd, schedule: { ...p.dnd.schedule, ...patch } } }));

  const setDnd = (minutes: number | undefined) => {
    runtime.node.setDnd(minutes).catch((e: unknown) => notice('Nicht gespeichert', errorText(e)));
  };

  let statusLine: string;
  if (!dndActive) statusLine = 'Benachrichtigungen kommen ganz normal.';
  else if (manualOn) statusLine = dnd.manual?.until ? `bis ${clockWithDay(dnd.manual.until, now)} Uhr (${inTime(dnd.manual.until, now)})` : 'bis du ihn ausschaltest';
  else statusLine = dndEndsAt ? `nach Zeitplan, bis ${clockWithDay(dndEndsAt, now)} Uhr` : 'nach Zeitplan';

  const durations: { label: string; minutes: number | undefined; selected: boolean }[] = [
    { label: '30 Min.', minutes: 30, selected: false },
    { label: '1 Std.', minutes: 60, selected: false },
    { label: '2 Std.', minutes: 120, selected: false },
    { label: seven.tomorrow ? 'Bis morgen 7 Uhr' : 'Bis 7 Uhr', minutes: seven.minutes, selected: false },
    { label: 'Bis ich es ausschalte', minutes: undefined, selected: manualOn && dnd.manual?.until === undefined },
  ];

  return (
    <Screen edges={['bottom']}>
      <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', gap: spacing.md }}>
        {/* ---- quiet mode now ---- */}
        <Card style={{ gap: spacing.md, borderColor: dndActive ? t.info : t.border, borderWidth: dndActive ? 2 : 1 }}>
          <Row gap={spacing.md}>
            <Text accessible={false} style={{ fontSize: 32 }}>
              {dndActive ? '🌙' : '🔔'}
            </Text>
            <View style={{ flex: 1, gap: 2 }} accessibilityLiveRegion="polite">
              <T variant="h2">{dndActive ? 'Ruhemodus ist an' : 'Ruhemodus ist aus'}</T>
              <T variant="small">{statusLine}</T>
            </View>
            {manualOn && <Button title="Ausschalten" kind="secondary" compact onPress={() => setDnd(0)} />}
          </Row>
          {dndActive && !manualOn && (
            <T variant="small">Ändern kannst du das unten beim Zeitplan.</T>
          )}
          <T variant="small">{manualOn ? 'Verlängern oder ändern:' : 'Jetzt einschalten:'}</T>
          <Wrap>
            {durations.map((d) => (
              <Chip key={d.label} label={d.label} selected={d.selected} onPress={() => setDnd(d.minutes)} />
            ))}
          </Wrap>
        </Card>

        {/* ---- what still comes through ---- */}
        <Section title="Was trotzdem durchkommt">
          <Card>
            <Row style={{ alignItems: 'flex-start' }} gap={spacing.md}>
              <Text accessible={false} style={{ fontSize: 22 }}>
                🆘
              </Text>
              <View style={{ flex: 1, gap: 2 }}>
                <T style={{ fontWeight: '700' }}>Ein Notruf kommt immer durch</T>
                <T variant="small">Laut und sofort, egal was du hier einstellst.</T>
              </View>
            </Row>
          </Card>
          <Card>
            <Toggle
              label="„Pass auf mich auf“-Alarme"
              detail="Wenn sich jemand nicht rechtzeitig meldet. Empfohlen: an."
              value={dnd.allowWatch}
              onChange={(v) => saveDnd({ allowWatch: v })}
            />
            <Toggle
              label="Alles von Favoriten"
              detail="Favoriten markierst du beim Kontakt mit ⭐."
              value={dnd.allowFavorites}
              onChange={(v) => saveDnd({ allowFavorites: v })}
            />
            <View style={{ gap: spacing.sm, paddingVertical: spacing.sm }}>
              <T>Als „dringend“ markierte Nachrichten von</T>
              <Wrap>
                {URGENT.map((u) => (
                  <Chip key={u.value} label={u.label} selected={dnd.urgentFrom === u.value} onPress={() => saveDnd({ urgentFrom: u.value })} />
                ))}
              </Wrap>
            </View>
            <Toggle
              label="Kontakten zeigen, dass ich Ruhe habe"
              detail="Sie sehen 🌙 und wissen, dass sie Wichtiges als dringend markieren können."
              value={dnd.share}
              onChange={(v) => saveDnd({ share: v })}
            />
          </Card>
        </Section>

        {/* ---- schedule ---- */}
        <Section title="Feste Ruhezeit">
          <Card style={{ gap: spacing.md }}>
            <Toggle
              label="Automatisch nach Zeitplan"
              detail="z. B. jede Nacht von 22 bis 7 Uhr"
              value={dnd.schedule.enabled}
              onChange={(v) => saveSchedule({ enabled: v })}
            />
            {dnd.schedule.enabled && (
              <>
                <Row style={{ alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <TimeField label="Von" value={dnd.schedule.from} onSave={(from) => saveSchedule({ from })} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <TimeField label="Bis" value={dnd.schedule.to} onSave={(to) => saveSchedule({ to })} />
                  </View>
                </Row>
                {dnd.schedule.from === dnd.schedule.to && <T color={t.danger}>Start und Ende sind gleich, so gibt es keine Ruhezeit.</T>}
                <T variant="small">An diesen Tagen (Beginn der Ruhezeit):</T>
                <Wrap>
                  {WEEKDAYS.map((w) => {
                    const on = dnd.schedule.days.includes(w.day);
                    return (
                      <Chip
                        key={w.day}
                        label={w.short}
                        selected={on}
                        onPress={() =>
                          saveSchedule({ days: on ? dnd.schedule.days.filter((d) => d !== w.day) : [...dnd.schedule.days, w.day].sort() })
                        }
                      />
                    );
                  })}
                </Wrap>
                {dnd.schedule.days.length === 0 && <T color={t.danger}>Kein Tag gewählt: Die Ruhezeit greift nie.</T>}
              </>
            )}
          </Card>
        </Section>

        {/* ---- per category ---- */}
        <Section title="Benachrichtigungen nach Art">
          <T variant="small">Ausgeschaltetes landet nur still in der Aktivität.</T>
          <Card>
            {ALERT_CATEGORIES.map((c) => {
              const locked = ALWAYS_ON.includes(c);
              const on = locked || !prefs.off.includes(c);
              const text = CATEGORY_TEXT[c];
              if (locked) {
                return (
                  <Row key={c} style={{ justifyContent: 'space-between', minHeight: 44 }} gap={spacing.md}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <T>{text.label}</T>
                      {text.detail ? <T variant="small">{text.detail}</T> : null}
                    </View>
                    <T variant="small" color={t.success}>
                      🔒 immer an
                    </T>
                  </Row>
                );
              }
              return (
                <Toggle
                  key={c}
                  label={text.label}
                  detail={text.detail}
                  value={on}
                  onChange={(v) => save((p) => ({ ...p, off: v ? p.off.filter((x) => x !== c) : [...p.off.filter((x) => x !== c), c] }))}
                />
              );
            })}
          </Card>
        </Section>

        <Reliability />
      </View>
    </Screen>
  );
}

function TimeField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string>();
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const parsed = parseTime(text);
    if (!parsed) {
      setError('Bitte als Uhrzeit, z. B. 22:00');
      setText(value);
      return;
    }
    setError(undefined);
    setText(parsed);
    if (parsed !== value) onSave(parsed);
  };
  return (
    <Field
      label={label}
      value={text}
      onChangeText={(v) => setText(v.replace(/[^\d:.]/g, ''))}
      onBlur={commit}
      onSubmitEditing={commit}
      maxLength={5}
      keyboardType="numbers-and-punctuation"
      placeholder="22:00"
      error={error}
      accessibilityLabel={`${label} (Uhrzeit)`}
      returnKeyType="done"
    />
  );
}

// ---- reliability ------------------------------------------------------------------------------

function Reliability() {
  const t = useTheme();
  const runtime = useRuntime();
  const { settings, isDemo } = useSnapshot();
  const [allowed, setAllowed] = useState<boolean>();
  const [dndAccess, setDndAccess] = useState<boolean>();
  const [battery, setBattery] = useState<boolean>();
  const [autostart, setAutostart] = useState<boolean>();

  const refresh = useCallback(() => {
    void notificationsAllowed()
      .then(setAllowed)
      .catch(() => setAllowed(false));
    // Also switchable in the tray menu, so read again whenever the window comes back.
    if (autostartSupported) {
      void desktop!
        .getAutostart()
        .then(setAutostart)
        .catch(() => setAutostart(undefined));
    }
    if (Platform.OS === 'android' && keepAliveSupported) {
      void isDndAccessGranted()
        .then(setDndAccess)
        .catch(() => setDndAccess(undefined));
      void isIgnoringBatteryOptimizations()
        .then(setBattery)
        .catch(() => setBattery(undefined));
    }
  }, []);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  async function allow() {
    const ok = await setupNotifications().catch(() => false);
    setAllowed(ok);
    if (!ok && isNative) await Linking.openSettings().catch(() => {});
  }

  async function changeAutostart(on: boolean) {
    setAutostart(on);
    try {
      await desktop!.setAutostart(on);
    } catch {
      notice('Hat nicht geklappt', 'Du kannst es auch über das Heyda.-Symbol im Infobereich einstellen.');
    }
    // What Windows really has now.
    setAutostart(await desktop!.getAutostart().catch(() => undefined));
  }

  async function openDndAccess() {
    try {
      await Linking.sendIntent('android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS');
    } catch {
      await Linking.openSettings().catch(() => notice('Einstellungen nicht geöffnet', 'Öffne die Android-Einstellungen und suche nach „Bitte nicht stören“-Zugriff.'));
    }
  }

  return (
    <Section title="Damit Alarme zuverlässig ankommen">
      <Card style={{ gap: spacing.md }}>
        {isBrowserPreview ? (
          <StatusLine ok={false} title="Browser-Vorschau" detail="Hier gibt es keine echten Benachrichtigungen. Auf dem Handy und am PC schon." />
        ) : isDesktop && autostartSupported ? (
          <>
            <StatusLine
              ok={autostart}
              title={autostart === undefined ? 'Start mit Windows …' : autostart ? 'Heyda. startet mit Windows' : 'Heyda. startet nicht mit Windows'}
              detail={
                autostart === false
                  ? 'Nach einem Neustart des PCs kommen Notrufe und Alarme hier erst an, wenn du Heyda. wieder öffnest.'
                  : 'Die Windows-App läuft im Infobereich weiter und meldet sich sofort, solange der PC an ist.'
              }
            />
            {autostart !== undefined && (
              <Toggle label="Beim Windows-Start öffnen" value={autostart} onChange={(v) => void changeAutostart(v)} />
            )}
          </>
        ) : isDesktop ? (
          <StatusLine ok title="Benachrichtigungen am PC" detail="Die Windows-App läuft im Infobereich weiter und meldet sich sofort, solange der PC an ist." />
        ) : (
          <>
            <StatusLine
              ok={allowed}
              title={allowed === undefined ? 'Benachrichtigungen …' : allowed ? 'Benachrichtigungen sind erlaubt' : 'Benachrichtigungen sind aus'}
              detail={allowed === false ? 'Ohne sie siehst du einen Notruf erst, wenn du die App öffnest.' : undefined}
            />
            {allowed === false && <Button title="Benachrichtigungen erlauben" icon="🔔" onPress={() => void allow()} />}
          </>
        )}

        {Platform.OS === 'android' && (
          <>
            <View style={{ height: 1, backgroundColor: t.border }} />
            <StatusLine
              ok={keepAliveSupported ? dndAccess : undefined}
              title={
                !keepAliveSupported || dndAccess === undefined
                  ? '„Bitte nicht stören“ durchbrechen'
                  : dndAccess
                    ? 'Alarme klingeln auch bei „Bitte nicht stören“'
                    : 'Alarme bleiben bei „Bitte nicht stören“ stumm'
              }
              detail="Erlaube Heyda. den „Bitte nicht stören“-Zugriff, damit ein Notruf auch dann klingelt, wenn dein Handy stumm ist."
            />
            {dndAccess !== true && <Button title="Zugriff erlauben" icon="🔕" kind="secondary" onPress={() => void openDndAccess()} />}

            {keepAliveSupported && (
              <>
                <View style={{ height: 1, backgroundColor: t.border }} />
                <Toggle
                  label="Immer verbunden bleiben"
                  detail={
                    'Eine dauerhafte Benachrichtigung „Heyda. ist verbunden“ hält die Verbindung offen. So kommen Nachrichten und Alarme sofort an, auch wenn die App zu ist. Kostet etwas Akku.' +
                    (isDemo ? ' (Im Demo-Modus nicht aktiv.)' : '')
                  }
                  value={settings.keepAlive}
                  onChange={(v) => runtime.updateSettings({ keepAlive: v })}
                />
                <StatusLine
                  ok={battery}
                  title={battery === undefined ? 'Akku-Optimierung …' : battery ? 'Akku-Optimierung ist aus' : 'Android darf Heyda. im Hintergrund pausieren'}
                  detail={battery === false ? 'Stell Heyda. auf „Nicht optimieren“ bzw. „Uneingeschränkt“, damit nichts verloren geht.' : undefined}
                />
                {battery === false && (
                  <Button
                    title="Akku-Einstellungen öffnen"
                    icon="🔋"
                    kind="secondary"
                    onPress={() => void openBatteryOptimizationSettings().catch(() => Linking.openSettings().catch(() => {}))}
                  />
                )}
              </>
            )}
            {!keepAliveSupported && (
              <T variant="small">Ohne Dauerverbindung schaut Android ungefähr alle 15 Minuten nach Neuem.</T>
            )}
          </>
        )}

        {Platform.OS === 'ios' && (
          <>
            <View style={{ height: 1, backgroundColor: t.border }} />
            <Hint>
              Ehrlich gesagt: Auf dem iPhone kommen Nachrichten an, wenn die App offen ist oder wenn iOS sie im Hintergrund kurz
              aufweckt – das ist ungefähr alle 15 Minuten oder seltener. „Pass auf mich auf“-Alarme sind dagegen direkt auf deinem
              iPhone geplant und klingeln pünktlich. Erlaube in den iOS-Einstellungen „Zeitkritische Mitteilungen“ für Heyda., damit
              Alarme auch im Fokus-Modus durchkommen.
            </Hint>
          </>
        )}
      </Card>
      <Button title="Notfall-Einstellungen" icon="🆘" kind="ghost" compact onPress={() => router.push('/safety')} />
    </Section>
  );
}

function StatusLine({ ok, title, detail }: { ok: boolean | undefined; title: string; detail?: string }) {
  const t = useTheme();
  const icon = ok === undefined ? 'ℹ️' : ok ? '✅' : '⚠️';
  return (
    <Row style={{ alignItems: 'flex-start' }} gap={spacing.md}>
      <Text accessible={false} style={{ fontSize: 18 }}>
        {icon}
      </Text>
      <View style={{ flex: 1, gap: 2 }}>
        <T style={{ fontWeight: '700' }} color={ok === false ? t.danger : t.text}>
          {title}
        </T>
        {detail ? <T variant="small">{detail}</T> : null}
      </View>
    </Row>
  );
}
