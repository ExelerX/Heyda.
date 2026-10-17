import type { LinkPayload } from '@heyda/core';
import * as Clipboard from 'expo-clipboard';
import { Redirect, router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BackHandler, Platform, Pressable, Text, View } from 'react-native';
import { QrCode } from '../components/QrCode';
import { Banner, Bullet, Digits, errorText, Field, MONO, Narrow, Step } from '../components/setup/kit';
import { RestoreFlow } from '../components/setup/RestoreFlow';
import { Button, Card, Pill, Row, Screen, T, Toggle } from '../components/ui';
import { confirm, notice } from '../lib/confirm';
import { isIgnoringBatteryOptimizations, keepAliveSupported, openBatteryOptimizationSettings } from '../lib/keepalive';
import { DEMO_KEYS } from '../lib/demo';
import { beginLinkReceive, completeLink, type LinkSession } from '../lib/link';
import { locationSupported, requestLocationAccess, type LocationAccess } from '../lib/location';
import { notificationsAllowed, setupNotifications } from '../lib/notifications';
import { autostartSupported, desktop, isBrowserPreview, isDesktop } from '../lib/platform';
import { getRuntime } from '../lib/runtime';
import { useRestart, useRuntime, useSnapshot, useTick } from '../lib/store';
import { radius, spacing, TOUCH, useTheme } from '../lib/theme';

type StepName = 'intro' | 'choose' | 'name' | 'permissions' | 'link' | 'restore';

const BACK: Partial<Record<StepName, StepName>> = {
  choose: 'intro',
  name: 'choose',
  permissions: 'name',
  link: 'choose',
  restore: 'choose',
};

const NAME_MAX = 40;

/** Onboarding: a short intro, then start fresh, link to another device, restore a backup or try the demo. */
export default function Welcome() {
  const runtime = useRuntime();
  const { state, settings, isDemo } = useSnapshot();
  const [step, setStep] = useState<StepName>('intro');
  const [name, setName] = useState(() => (state.self.name && state.self.name !== 'Ich' ? state.self.name : ''));

  // Android back button: one step back instead of leaving the app.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const prev = BACK[step];
      if (!prev) return false;
      setStep(prev);
      return true;
    });
    return () => sub.remove();
  }, [step]);

  // A set-up account never comes back here (a link could open this screen): restoring a backup
  // lives under Sicherung, and the demo is not something to switch a real account to by accident.
  if (settings.onboarded && !isDemo) return <Redirect href="/" />;

  const back = BACK[step];
  return (
    <Screen edges={['top', 'bottom']}>
      <Narrow style={{ maxWidth: 560 }}>
        {back ? (
          <Pressable
            onPress={() => setStep(back)}
            accessibilityRole="button"
            accessibilityLabel="Zurück"
            style={{ minHeight: TOUCH, justifyContent: 'center', alignSelf: 'flex-start', paddingRight: spacing.lg }}
          >
            <BackLabel />
          </Pressable>
        ) : null}
        {step === 'intro' && <Intro onNext={() => setStep('choose')} />}
        {step === 'choose' && <Choose onPick={setStep} />}
        {step === 'name' && <NameStep name={name} setName={setName} onNext={() => setStep('permissions')} />}
        {step === 'permissions' && <Permissions name={name} />}
        {step === 'link' && <LinkReceive />}
        {step === 'restore' && (
          <View style={{ gap: spacing.md }}>
            <T variant="title">Sicherung wiederherstellen</T>
            <T variant="muted">Hol dein Konto mit Kontakten, Orten und Automationen aus einer Sicherungsdatei zurück.</T>
            <RestoreFlow warnReplace={runtime.settings.onboarded && !runtime.isDemo} />
          </View>
        )}
      </Narrow>
    </Screen>
  );
}

function BackLabel() {
  const t = useTheme();
  return <Text style={{ color: t.accent, fontSize: 16, fontWeight: '700' }}>‹ Zurück</Text>;
}

// ---- intro -----------------------------------------------------------------------------------

const POINTS = [
  {
    icon: '🕐',
    title: 'Wann du ankommst, nicht wo du bist',
    text: 'Deine Freunde sehen „Lisa ist in ca. 5 min da“, aber nicht, wo du gerade bist.',
  },
  {
    icon: '🔒',
    title: 'Verschlüsselt, ohne Server',
    text: 'Alles ist Ende-zu-Ende-verschlüsselt. Es gibt keinen Heyda.-Server, kein Konto, keine Telefonnummer und keine Werbung.',
  },
  {
    icon: '🙋',
    title: 'Du entscheidest',
    text: 'Was du teilst, mit wem und wie lange. Freigaben enden von selbst, und der Geistmodus pausiert alles auf einmal.',
  },
];

function Wordmark() {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" accessibilityLabel="Heyda." style={{ color: t.text, fontSize: 44, fontWeight: '900', letterSpacing: -1 }}>
      Heyda<Text style={{ color: t.accent }}>.</Text>
    </Text>
  );
}

function Intro({ onNext }: { onNext: () => void }) {
  return (
    <View style={{ gap: spacing.lg, marginTop: spacing.xl }}>
      <View style={{ gap: spacing.xs }}>
        <Wordmark />
        <T variant="big">Hey, da bist du ja 👋</T>
        <T variant="muted">Die App für Familie und Freunde, die wissen wollen, dass du gut ankommst.</T>
      </View>
      {POINTS.map((p) => (
        <Card key={p.title}>
          <Row gap={spacing.md} style={{ alignItems: 'flex-start' }}>
            <Text style={{ fontSize: 28 }} accessible={false}>
              {p.icon}
            </Text>
            <View style={{ flex: 1, gap: 2 }}>
              <T variant="h2">{p.title}</T>
              <T variant="muted">{p.text}</T>
            </View>
          </Row>
        </Card>
      ))}
      <Button title="Los geht's" onPress={onNext} style={{ marginTop: spacing.sm }} />
    </View>
  );
}

// ---- choose ----------------------------------------------------------------------------------

function ChoiceCard({ icon, title, text, onPress, disabled, note, busy }: {
  icon: string;
  title: string;
  text: string;
  onPress: () => void;
  disabled?: boolean;
  note?: string;
  busy?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${text}${note ? `. ${note}` : ''}`}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: spacing.md,
        alignItems: 'center',
        backgroundColor: pressed ? t.surfaceRaised : t.surface,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: spacing.lg,
        opacity: disabled ? 0.55 : 1,
      })}
    >
      <Text style={{ fontSize: 28 }} accessible={false}>
        {icon}
      </Text>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="h2">{title}</T>
        <T variant="small">{text}</T>
        {note ? (
          <View style={{ alignSelf: 'flex-start', marginTop: spacing.xs }}>
            <Pill text={note} color={t.textMuted} />
          </View>
        ) : null}
      </View>
      <Text style={{ color: t.textMuted, fontSize: 24 }} accessible={false}>
        {busy ? '…' : '›'}
      </Text>
    </Pressable>
  );
}

function Choose({ onPick }: { onPick: (s: StepName) => void }) {
  const runtime = useRuntime();
  const restart = useRestart();
  const [busy, setBusy] = useState(false);

  async function startDemo() {
    const s = runtime.getSnapshot().state;
    // Left over after ending the demo, or an account restored or linked but not finished here.
    const real = s.contacts.some((c) => !DEMO_KEYS.includes(c.key)) || s.devices.some((d) => d.deviceId !== s.self.deviceId);
    if (
      real &&
      !runtime.isDemo &&
      !(await confirm({
        title: 'Demo starten?',
        message: 'Solange die Demo läuft, ist dein Konto offline: Nachrichten, Notrufe und „Pass auf mich auf“ kommen weder bei dir noch bei deinen Kontakten an. Was du in der Demo machst, ist danach wieder weg.',
        ok: 'Demo starten',
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      runtime.finishOnboarding();
      if (!runtime.isDemo) {
        await runtime.setDemo(true);
        await restart();
      }
      router.replace('/');
    } catch (e) {
      notice('Demo konnte nicht starten', errorText(e));
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: spacing.md }}>
      <T variant="title">Wie möchtest du starten?</T>
      {isBrowserPreview && (
        <Banner tone="info" title="Web-Vorschau">
          Hier läuft immer die Demo mit drei simulierten Freunden. Nichts verlässt deinen Browser.
        </Banner>
      )}
      <ChoiceCard icon="🌱" title="Neu starten" text="Ich bin neu bei Heyda." onPress={() => onPick('name')} />
      <ChoiceCard
        icon="🔗"
        title="Ich habe Heyda. schon auf einem anderen Gerät"
        text="Verbinde dieses Gerät mit deinem Konto, z. B. den PC mit deinem Handy."
        onPress={() => onPick('link')}
        disabled={isBrowserPreview}
        note={isBrowserPreview ? 'Nur in der App' : undefined}
      />
      <ChoiceCard
        icon="💾"
        title="Sicherung wiederherstellen"
        text="Aus einer Sicherungsdatei mit deinem Passwort, z. B. auf einem neuen Handy."
        onPress={() => onPick('restore')}
        disabled={isBrowserPreview}
        note={isBrowserPreview ? 'Nur in der App' : undefined}
      />
      <ChoiceCard
        icon="🎮"
        title="Erst mal ausprobieren (Demo)"
        text="Mit drei simulierten Freunden: Lisa, Max und Oma Ilse. Nichts verlässt dein Gerät."
        onPress={() => void startDemo()}
        busy={busy}
      />
    </View>
  );
}

// ---- new account -----------------------------------------------------------------------------

function NameStep({ name, setName, onNext }: { name: string; setName: (v: string) => void; onNext: () => void }) {
  const ok = name.trim().length > 0;
  return (
    <View style={{ gap: spacing.lg }}>
      <T variant="title">Wie heißt du?</T>
      <T variant="muted">So sehen dich deine Freunde, z. B. „Lisa ist angekommen“. Am besten dein Vorname oder Spitzname.</T>
      <Field
        label="Dein Name"
        value={name}
        onChangeText={setName}
        placeholder="z. B. Lisa"
        maxLength={NAME_MAX}
        autoCapitalize="words"
        autoFocus
        counter
        onSubmitEditing={() => ok && onNext()}
      />
      <Button title="Weiter" onPress={onNext} disabled={!ok} />
    </View>
  );
}

const LOCATION_RESULT: Record<LocationAccess, string> = {
  always: '✅ Immer erlaubt. Ankunft und „gleich da“ klappen auch, wenn die App zu ist.',
  'while-using': '✅ Erlaubt, solange die App offen ist. Für Ankunft an deinen Orten brauchst du später „Immer erlauben“.',
  denied: 'Nicht erlaubt. Kein Problem: Du kannst es später in den Systemeinstellungen ändern.',
};

function PermissionCard({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <Card style={{ gap: spacing.sm }}>
      <Row gap={spacing.md}>
        <Text style={{ fontSize: 24 }} accessible={false}>
          {icon}
        </Text>
        <T variant="h2" style={{ flex: 1 }}>
          {title}
        </T>
      </Row>
      {children}
    </Card>
  );
}

/** Windows: start with Windows, for a new account and for one linked from another device alike. */
function AutostartCard({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <PermissionCard icon="🖥️" title="Mit Windows starten">
      <Toggle
        label="Empfohlen"
        detail="Dann läuft Heyda. nach jedem Neustart still im Infobereich, und Notrufe und Alarme kommen auch hier an."
        value={value}
        onChange={onChange}
      />
    </PermissionCard>
  );
}

function Permissions({ name }: { name: string }) {
  const t = useTheme();
  const runtime = useRuntime();
  const restart = useRestart();
  const [notif, setNotif] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [location, setLocation] = useState<LocationAccess>();
  const [keepAlive, setKeepAlive] = useState(true);
  const [autostart, setAutostart] = useState(true);
  const [batteryOk, setBatteryOk] = useState(true);
  const [busy, setBusy] = useState<'notif' | 'location' | 'finish'>();
  const canNotify = !isBrowserPreview;

  useEffect(() => {
    if (canNotify) void notificationsAllowed().then((ok) => ok && setNotif('granted')).catch(() => {});
    if (keepAliveSupported) void isIgnoringBatteryOptimizations().then(setBatteryOk).catch(() => {});
  }, [canNotify]);

  async function askNotifications() {
    setBusy('notif');
    try {
      setNotif((await setupNotifications()) ? 'granted' : 'denied');
    } finally {
      setBusy(undefined);
    }
  }

  async function askLocation() {
    setBusy('location');
    try {
      setLocation(await requestLocationAccess());
    } catch {
      setLocation('denied');
    } finally {
      setBusy(undefined);
    }
  }

  async function finish() {
    setBusy('finish');
    try {
      if (keepAliveSupported) runtime.updateSettings({ keepAlive });
      // Can be changed later under Ruhe or in the tray menu.
      if (autostartSupported) await desktop!.setAutostart(autostart).catch(() => {});
      if (runtime.isDemo && !isBrowserPreview) {
        // Someone who tried the demo first and now starts for real: the account comes back as it
        // was before the demo (nothing from the demo goes along), and gets the name there.
        runtime.finishOnboarding();
        await runtime.setDemo(false);
        await restart();
        await (await getRuntime()).setDisplayName(name);
      } else {
        await runtime.setDisplayName(name);
        runtime.finishOnboarding();
      }
      router.replace('/');
    } catch (e) {
      notice('Das hat nicht geklappt', errorText(e));
      setBusy(undefined);
    }
  }

  return (
    <View style={{ gap: spacing.md }}>
      <T variant="title">{`Fast fertig, ${name.trim()}!`}</T>
      <T variant="muted">Zwei kurze Fragen. Du kannst alles später ändern.</T>

      <PermissionCard icon="🔔" title="Benachrichtigungen">
        <T variant="muted">Damit du mitbekommst, wenn jemand ankommt, schreibt oder Hilfe braucht. Sie entstehen direkt auf deinem Gerät, ohne fremden Server.</T>
        {!canNotify ? (
          <T variant="small">In der Web-Vorschau gibt es keine Benachrichtigungen.</T>
        ) : notif === 'granted' ? (
          <T color={t.success}>✅ Erlaubt</T>
        ) : (
          <>
            {notif === 'denied' && <T variant="small">Nicht erlaubt. Du kannst das später in den Systemeinstellungen ändern.</T>}
            <Button title={notif === 'denied' ? 'Nochmal fragen' : 'Benachrichtigungen erlauben'} kind="secondary" compact onPress={() => void askNotifications()} busy={busy === 'notif'} />
          </>
        )}
      </PermissionCard>

      <PermissionCard icon="📍" title="Standort (freiwillig)">
        <T variant="muted">
          Brauchst du für Ankunftszeiten und deine Orte. Dein genauer Standort bleibt auf deinem Gerät: Freunde bekommen nur, was du freigibst, z. B. „in ca. 10 min da“.
        </T>
        {!locationSupported ? (
          <T variant="small">{isDesktop ? 'Am PC gibt es kein GPS. Ankunftszeiten teilst du vom Handy aus.' : 'In der Web-Vorschau gibt es keinen Standort.'}</T>
        ) : location ? (
          <T variant="small" color={location === 'denied' ? t.textMuted : t.success}>
            {LOCATION_RESULT[location]}
          </T>
        ) : (
          <>
            <Button title="Standort erlauben" kind="secondary" compact onPress={() => void askLocation()} busy={busy === 'location'} />
            <T variant="small">Oder später: Wenn du zum ersten Mal eine Ankunftszeit teilst, fragt die App dich.</T>
          </>
        )}
      </PermissionCard>

      {keepAliveSupported && (
        <PermissionCard icon="📶" title="Im Hintergrund verbunden bleiben">
          <Toggle
            label="Empfohlen"
            detail="Damit Notrufe und Nachrichten sofort ankommen, auch wenn die App zu ist. Android zeigt dafür eine kleine, dauerhafte Benachrichtigung."
            value={keepAlive}
            onChange={setKeepAlive}
          />
          {keepAlive && !batteryOk && (
            <>
              <T variant="small">Manche Handys beenden Apps trotzdem, um Akku zu sparen. Stell Heyda. dort auf „Nicht optimieren“.</T>
              <Button
                title="Akku-Einstellungen öffnen"
                kind="ghost"
                compact
                onPress={() => void openBatteryOptimizationSettings().catch(() => notice('Konnte die Einstellungen nicht öffnen'))}
              />
            </>
          )}
        </PermissionCard>
      )}

      {autostartSupported && <AutostartCard value={autostart} onChange={setAutostart} />}

      <Button title="Fertig" icon="🚀" onPress={() => void finish()} busy={busy === 'finish'} disabled={!!busy} style={{ marginTop: spacing.sm }} />
    </View>
  );
}

// ---- link to an existing account -------------------------------------------------------------

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function LinkReceive() {
  const t = useTheme();
  const runtime = useRuntime();
  const restart = useRestart();
  const now = useTick(1000);
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<LinkSession>();
  // The 6 digits, once my other device answered and got this device's secret. Before that
  // there is nothing to compare, so only the code is shown.
  const [digits, setDigits] = useState<string>();
  // The person said the digits match here too. Only then may an arriving account be shown.
  const [digitsOk, setDigitsOk] = useState(false);
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'confirm' | 'rejected' | 'received' | 'error'>('starting');
  // The received account waits here until the person confirms it is theirs. Only in component
  // state (gone on unmount), never logged, and dropped on "Nein" or a new attempt.
  const [pending, setPending] = useState<LinkPayload>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  // Offered with the account, as when starting a new one.
  const [autostart, setAutostart] = useState(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Kept in refs so a re-render (restart handed out a new function) never cancels a running link.
  const restartRef = useRef(restart);
  restartRef.current = restart;
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  useEffect(() => {
    let cancelled = false;
    let current: LinkSession | undefined;
    setPhase('starting');
    setError(undefined);
    setSession(undefined);
    setDigits(undefined);
    setDigitsOk(false);
    setPending(undefined);
    beginLinkReceive().then(
      (s) => {
        s.result.catch(() => {});
        if (cancelled) {
          s.cancel();
          return;
        }
        current = s;
        setSession(s);
        setPhase('waiting');
        void s.digits.then((d) => {
          if (!cancelled) setDigits(d);
        });
        s.result.then(
          (payload) => {
            if (cancelled) return;
            // Do not take it over yet: anyone who saw the code could have sent their account.
            setPending(payload);
            setPhase('confirm');
          },
          (e) => {
            if (cancelled) return;
            setError(errorText(e));
            setPhase('error');
          },
        );
      },
      () => {
        if (cancelled) return;
        setError('Keine Verbindung zum Internet. Prüfe dein WLAN oder deine mobilen Daten und versuch es nochmal.');
        setPhase('error');
      },
    );
    return () => {
      cancelled = true;
      current?.cancel();
    };
  }, [attempt]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  async function accept() {
    const payload = pending;
    if (!payload || phase !== 'confirm') return;
    setPending(undefined);
    setPhase('received');
    let stopped = false;
    try {
      // Can be changed later under Ruhe or in the tray menu.
      if (autostartSupported) await desktop!.setAutostart(autostart).catch(() => {});
      // Stop this device's empty account first so it cannot save over the received one.
      await runtimeRef.current.shutdown(false);
      stopped = true;
      await completeLink(payload);
      await restartRef.current();
      try {
        router.replace('/');
      } catch {
        // Already at the start screen after the restart.
      }
    } catch (e) {
      setError(errorText(e, 'Das Konto konnte nicht gespeichert werden.'));
      setPhase('error');
      if (stopped) {
        notice('Verbinden hat nicht geklappt', errorText(e));
        await restartRef.current().catch(() => {});
      }
    }
  }

  function reject() {
    setPending(undefined);
    setPhase('rejected');
  }

  async function copy() {
    if (!session) return;
    try {
      await Clipboard.setStringAsync(session.code);
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      notice('Kopieren hat nicht geklappt', 'Markiere den Text und kopiere ihn von Hand.');
    }
  }

  const left = session ? session.expiresAt - now : 0;
  const expired = phase === 'waiting' && left <= 0;

  return (
    <View style={{ gap: spacing.md }}>
      <T variant="title">Mit deinem Konto verbinden</T>
      {(phase === 'starting' || (phase === 'waiting' && !digits) || phase === 'error') && (
        <Card style={{ gap: spacing.sm }}>
          <Step n={1}>Öffne Heyda. auf deinem anderen Gerät, auf dem dein Konto schon läuft.</Step>
          <Step n={2}>Tippe dort auf Ich → Meine Geräte → „Neues Gerät verbinden“.</Step>
          <Step n={3}>Scanne diesen QR-Code. Am PC: Kopiere den Code-Text unten und füge ihn dort ein.</Step>
          <Step n={4}>Dann zeigen beide Geräte 6 Zahlen. Sind sie gleich, bestätige auf beiden Geräten.</Step>
        </Card>
      )}

      {phase === 'confirm' && pending && (
        <ConfirmAccount payload={pending} onYes={() => void accept()} onNo={reject}>
          {autostartSupported && <AutostartCard value={autostart} onChange={setAutostart} />}
        </ConfirmAccount>
      )}

      {phase === 'rejected' && (
        <>
          <Banner tone="warn" title="Abgebrochen">
            Dann hat jemand anderes deinen Code benutzt. Starte neu und zeige den Code nur deinem eigenen Gerät.
          </Banner>
          <Button title="Neu starten" icon="🔄" onPress={() => setAttempt((a) => a + 1)} />
        </>
      )}

      {phase === 'starting' && (
        <Card style={{ alignItems: 'center', paddingVertical: spacing.xxl }}>
          <T variant="muted">Code wird erstellt…</T>
        </Card>
      )}

      {phase === 'error' && (
        <>
          <Banner tone="danger" title="Hat nicht geklappt">
            {error ?? 'Unbekannter Fehler.'}
          </Banner>
          <Button title="Nochmal versuchen" onPress={() => setAttempt((a) => a + 1)} />
        </>
      )}

      {phase === 'received' && (
        <Banner tone="success" title="Konto empfangen">
          Dein Konto wird eingerichtet. Gleich geht's los…
        </Banner>
      )}

      {phase === 'waiting' && session && (
        expired ? (
          <>
            <Banner tone="warn" title="Code abgelaufen">
              Aus Sicherheitsgründen gilt jeder Code nur 10 Minuten.
            </Banner>
            <Button title="Neuen Code erstellen" onPress={() => setAttempt((a) => a + 1)} />
          </>
        ) : digits && !digitsOk ? (
          <>
            <View accessibilityLiveRegion="polite" style={{ gap: spacing.md }}>
              <T variant="h2" style={{ textAlign: 'center' }}>
                Prüfe: Dein anderes Gerät zeigt jetzt dieselben 6 Zahlen. Bestätige hier und dort.
              </T>
              <Digits value={digits} label="Vergleichszahlen" />
            </View>
            <T variant="small" style={{ textAlign: 'center' }}>{`Gültig noch ${countdown(left)}`}</T>
            <Bullet icon="⚠️">
              Tippe nur, wenn dein anderes Gerät genau diese Zahlen zeigt. Zeigt es andere oder gar keine, will vielleicht jemand anderes sein Konto hierher schicken.
            </Bullet>
            <Button
              title="Zahlen stimmen überein"
              icon="✅"
              onPress={() => {
                session.confirmDigits();
                setDigitsOk(true);
              }}
            />
            <Button
              title="Zahlen stimmen nicht"
              kind="secondary"
              onPress={() => {
                setAttempt((a) => a + 1);
                notice('Neu gestartet', 'Gut so. Brich auch auf deinem anderen Gerät ab und zeige den neuen Code nur deinem eigenen Gerät.');
              }}
            />
          </>
        ) : digits ? (
          <>
            <View accessibilityLiveRegion="polite" style={{ gap: spacing.md }}>
              <T variant="h2" style={{ textAlign: 'center' }}>
                Danke! Bestätige jetzt auch auf deinem anderen Gerät.
              </T>
              <Digits value={digits} label="Vergleichszahlen" />
            </View>
            <T variant="small" style={{ textAlign: 'center' }}>{`Gültig noch ${countdown(left)} · wartet auf deine Bestätigung dort…`}</T>
            <Bullet icon="🔐">
              Erst wenn du dort bestätigst, kommt dein Konto Ende-zu-Ende-verschlüsselt hier an. Nur dieses Gerät kann es lesen.
            </Bullet>
            <Bullet icon="⚠️">
              Zeigt dein anderes Gerät andere Zahlen oder gar keine? Dann brich dort ab und starte hier neu.
            </Bullet>
            <Button title="Neu starten" icon="🔄" kind="secondary" compact onPress={() => setAttempt((a) => a + 1)} />
          </>
        ) : (
          <>
            <T variant="h2" style={{ textAlign: 'center' }}>
              Scanne diesen Code mit deinem anderen Gerät
            </T>
            <QrCode value={session.code} size={240} label="Geräte-Code zum Scannen" />
            <T variant="small" style={{ textAlign: 'center' }}>{`Gültig noch ${countdown(left)} · wartet auf dein anderes Gerät…`}</T>
            <Card style={{ gap: spacing.sm }}>
              <T variant="small">Code-Text (zum Einfügen am PC):</T>
              <Text selectable style={{ color: t.text, fontFamily: MONO, fontSize: 12 }} numberOfLines={3}>
                {session.code}
              </Text>
              <Button title={copied ? 'Kopiert ✓' : 'Code-Text kopieren'} icon="📋" kind="secondary" compact onPress={() => void copy()} />
            </Card>
            <Bullet icon="🔐">
              Danach zeigen beide Geräte 6 Zahlen zum Vergleichen. Dein Konto kommt Ende-zu-Ende-verschlüsselt an. Nur dieses Gerät kann es lesen.
            </Bullet>
          </>
        )
      )}
    </View>
  );
}

/** Shows what arrived and lets the person refuse an account that is not theirs. `children` go above the answers. */
function ConfirmAccount({ payload, onYes, onNo, children }: { payload: LinkPayload; onYes: () => void; onNo: () => void; children?: ReactNode }) {
  const t = useTheme();
  const contacts = Array.isArray(payload.doc.contacts) ? payload.doc.contacts : [];
  const name = payload.doc.profileName?.trim() || 'ohne Namen';
  const examples = contacts
    .slice(0, 3)
    .map((c) => (c.nickname || c.name).trim())
    .filter(Boolean);
  const contactText =
    contacts.length === 0
      ? 'noch keine'
      : `${contacts.length}${examples.length ? ` (z. B. ${examples.join(', ')}${contacts.length > examples.length ? ', …' : ''})` : ''}`;
  const rows: { icon: string; label: string; value: string }[] = [
    { icon: '👤', label: 'Name', value: name },
    { icon: '📱', label: 'Gesendet von', value: payload.deviceName },
    { icon: '👥', label: 'Kontakte', value: contactText },
  ];
  return (
    <View style={{ gap: spacing.md }}>
      <Card style={{ gap: spacing.md, borderColor: t.accent, borderWidth: 1 }}>
        <T variant="h2">Ist das dein Konto?</T>
        <T variant="muted">Ein Konto ist angekommen. Es wird erst übernommen, wenn du bestätigst.</T>
        {rows.map((r) => (
          <Row key={r.label} gap={spacing.md} style={{ alignItems: 'flex-start' }}>
            <Text style={{ fontSize: 20 }} accessibilityElementsHidden importantForAccessibility="no">
              {r.icon}
            </Text>
            <View style={{ flex: 1 }} accessible accessibilityLabel={`${r.label}: ${r.value}`}>
              <T variant="small">{r.label}</T>
              <T style={{ fontWeight: '700' }}>{r.value}</T>
            </View>
          </Row>
        ))}
      </Card>
      <Bullet icon="⚠️">
        Kennst du den Namen oder das Gerät nicht? Dann tippe auf „Nein, abbrechen“. Sonst landet ein fremdes Konto auf diesem Gerät.
      </Bullet>
      {children}
      <Button title="Ja, das ist mein Konto" icon="✅" onPress={onYes} />
      <Button title="Nein, abbrechen" kind="secondary" onPress={onNo} />
    </View>
  );
}
