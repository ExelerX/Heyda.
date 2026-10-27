import type { LinkedDevice } from '@heyda/core';
import { Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Banner, Bullet, Digits, errorText, Narrow, Step } from '../components/setup/kit';
import { LinkScanner } from '../components/setup/LinkScanner';
import { Button, Card, Pill, Row, Screen, Section, T } from '../components/ui';
import { confirm, notice } from '../lib/confirm';
import { useRuntime, useSnapshot, useTick } from '../lib/store';
import { spacing, TOUCH, useTheme } from '../lib/theme';

/**
 * Linking from here: scan → starting (sending my share) → linking (the node's `linkStatus`:
 * waiting for the new device, then the digits) → sending → sent.
 */
type Flow =
  | { step: 'idle' }
  | { step: 'scan'; error?: string }
  | { step: 'starting' }
  | { step: 'linking'; expiresAt: number }
  | { step: 'sending'; code: string; expiresAt: number }
  | { step: 'sent'; known: number }
  | { step: 'failed'; error: string };

const EXPIRED = 'Die Zeit ist abgelaufen.';
const BAD_ANSWER = 'Das neue Gerät hat nicht passend geantwortet.';

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function deviceIcon(name: string): string {
  return /pc|windows|computer|laptop|mac|browser/i.test(name) ? '💻' : '📱';
}

function dateText(at: number): string {
  return new Date(at).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function Devices() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, isDemo, linkStatus } = useSnapshot();
  const [flow, setFlow] = useState<Flow>({ step: 'idle' });
  const others = state.devices.filter((d) => d.deviceId !== state.self.deviceId);
  const busyRef = useRef(false);
  // Counts link attempts, so a slow start that was cancelled meanwhile changes nothing.
  const attemptRef = useRef(0);
  const now = useTick(1000);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  // Leaving the screen ends a link in progress and wipes its secret.
  useEffect(() => () => runtimeRef.current.cancelLink(), []);

  // The link ended without a "yes" from here: the time ran out, or the new device answered wrongly.
  useEffect(() => {
    if (flow.step !== 'linking') return;
    if (Date.now() >= flow.expiresAt) {
      runtimeRef.current.cancelLink();
      setFlow({ step: 'failed', error: EXPIRED });
    } else if (!linkStatus) {
      setFlow({ step: 'failed', error: BAD_ANSWER });
    }
  }, [flow, linkStatus, now]);

  // A hello whose send failed may have arrived anyway (the node keeps the session for the same
  // code): if the new device answers while the scanner shows the error, go on to the digits.
  useEffect(() => {
    if (flow.step === 'scan' && linkStatus?.phase === 'compare') setFlow({ step: 'linking', expiresAt: linkStatus.expiresAt });
  }, [flow.step, linkStatus]);

  // The digits to compare, once the new device answered (kept while my account is being sent).
  const compareCode = flow.step === 'sending' ? flow.code : flow.step === 'linking' && linkStatus?.phase === 'compare' ? linkStatus.code : undefined;

  // After sending: the new device announces itself, then it shows up in the list.
  const newDevice = flow.step === 'sent' && others.length > flow.known ? others[others.length - 1] : undefined;
  useEffect(() => {
    if (flow.step !== 'sent') return;
    const id = setTimeout(() => setFlow((f) => (f.step === 'sent' ? { step: 'idle' } : f)), 5 * 60_000);
    return () => clearTimeout(id);
  }, [flow.step]);

  async function check(text: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    const attempt = ++attemptRef.current;
    setFlow({ step: 'starting' });
    try {
      await runtime.startLink(text.trim());
      // Cancelled meanwhile: the node already forgot this link.
      if (attempt !== attemptRef.current) return;
      const status = runtime.node.linkStatus;
      setFlow(status ? { step: 'linking', expiresAt: status.expiresAt } : { step: 'failed', error: BAD_ANSWER });
    } catch (e) {
      if (attempt === attemptRef.current) setFlow({ step: 'scan', error: errorText(e, 'Der Code passt nicht.') });
    } finally {
      if (attempt === attemptRef.current) busyRef.current = false;
    }
  }

  async function send(code: string, expiresAt: number) {
    if (busyRef.current) return;
    busyRef.current = true;
    setFlow({ step: 'sending', code, expiresAt });
    try {
      await runtime.confirmLink();
      setFlow({ step: 'sent', known: others.length });
    } catch (e) {
      if (runtime.node.linkStatus?.phase === 'compare') {
        // E.g. offline for a moment: the digits still count, so let the person try again.
        setFlow({ step: 'linking', expiresAt });
        notice('Nicht gesendet', errorText(e));
      } else {
        setFlow({ step: 'failed', error: Date.now() >= expiresAt ? EXPIRED : errorText(e, 'Das Konto konnte nicht gesendet werden.') });
      }
    } finally {
      busyRef.current = false;
    }
  }

  /** Ends any link in progress (and wipes its secret), then shows `next`. */
  function reset(next: Flow) {
    attemptRef.current++;
    busyRef.current = false;
    runtime.cancelLink();
    setFlow(next);
  }

  function cancelLink(afterCompare: boolean) {
    reset({ step: 'idle' });
    if (afterCompare) {
      notice('Abgebrochen', 'Gut so. Wenn die Zahlen nicht stimmen, könnte ein fremder Code dahinterstecken. Starte auf dem neuen Gerät eine neue Verbindung.');
    }
  }

  async function remove(d: LinkedDevice) {
    const ok = await confirm({
      title: `„${d.name}“ entfernen?`,
      message:
        'Dieses Gerät bekommt dann keine Änderungen mehr von hier. Aussperren kann Heyda. es aber nicht: Es nutzt weiter dein Konto, bis es dort zurückgesetzt wird.',
      ok: 'Entfernen',
      destructive: true,
    });
    if (!ok) return;
    try {
      runtime.node.removeDevice(d.deviceId);
    } catch (e) {
      notice('Das hat nicht geklappt', errorText(e));
    }
  }

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Meine Geräte' }} />
      <Narrow>
        <T variant="muted">
          Dein Konto kann auf mehreren Geräten laufen, z. B. auf dem Handy und am Windows-PC. Kontakte, Gruppen, Orte, Automationen und Einstellungen bleiben überall gleich.
        </T>

        <Card style={{ gap: 0, padding: 0, overflow: 'hidden' }}>
          <DeviceRow icon={deviceIcon(state.self.deviceName)} name={state.self.deviceName} detail="Hier bist du gerade" current first />
          {others.map((d) => (
            <DeviceRow key={d.deviceId} icon={deviceIcon(d.name)} name={d.name} detail={`Verbunden seit ${dateText(d.linkedAt)}`} onRemove={() => void remove(d)} />
          ))}
        </Card>
        {!others.length && <T variant="small">Noch keine weiteren Geräte.</T>}

        <Section title="Neues Gerät verbinden">
          {isDemo ? (
            <Banner tone="info" title="Im Demo-Modus nicht möglich">
              In der Demo gibt es kein echtes Konto, das du auf ein anderes Gerät bringen könntest.
            </Banner>
          ) : flow.step === 'idle' ? (
            <Card style={{ gap: spacing.md }}>
              <Step n={1}>Installiere Heyda. auf dem neuen Gerät und wähle dort „Ich habe Heyda. schon auf einem anderen Gerät“.</Step>
              <Step n={2}>Das neue Gerät zeigt einen QR-Code.</Step>
              <Step n={3}>Scanne den Code hier oder füge den Code-Text ein.</Step>
              <Step n={4}>Dann zeigen beide Geräte 6 Zahlen. Stimmen sie überein, bestätigst du auf beiden Geräten.</Step>
              <Button title="Neues Gerät verbinden" icon="🔗" onPress={() => setFlow({ step: 'scan' })} />
            </Card>
          ) : flow.step === 'scan' ? (
            <Card style={{ gap: spacing.md }}>
              <LinkScanner onCode={check} error={flow.error} />
              <Button title="Abbrechen" kind="ghost" compact onPress={() => reset({ step: 'idle' })} />
            </Card>
          ) : (flow.step === 'starting' || flow.step === 'linking') && compareCode === undefined ? (
            <Card style={{ gap: spacing.md, alignItems: 'center' }}>
              <ActivityIndicator color={t.accent} accessibilityElementsHidden importantForAccessibility="no" />
              <View accessible accessibilityLiveRegion="polite" style={{ gap: spacing.xs, alignItems: 'center' }}>
                <T variant="h2" style={{ textAlign: 'center' }}>
                  Verbinde mit dem neuen Gerät …
                </T>
                <T variant="muted" style={{ textAlign: 'center' }}>
                  Gleich zeigen beide Geräte 6 Zahlen. Lass das neue Gerät dafür offen.
                </T>
              </View>
              {flow.step === 'linking' && <T variant="small">{`Gültig noch ${countdown(flow.expiresAt - now)}`}</T>}
              <Button title="Abbrechen" kind="ghost" compact onPress={() => cancelLink(false)} />
            </Card>
          ) : (flow.step === 'linking' || flow.step === 'sending') && compareCode !== undefined ? (
            <Card style={{ gap: spacing.md }}>
              <View accessibilityLiveRegion="polite" style={{ gap: spacing.md }}>
                <T variant="h2" style={{ textAlign: 'center' }}>
                  Zeigt das neue Gerät genau diese Zahlen?
                </T>
                <Digits value={compareCode} label="Vergleichszahlen" />
              </View>
              <T variant="small" style={{ textAlign: 'center' }}>{`Gültig noch ${countdown(flow.expiresAt - now)}`}</T>
              <Bullet icon="🔐">
                Nur wenn sie gleich sind, ist es wirklich dein neues Gerät. Es bekommt dein ganzes Konto und kann danach in deinem Namen schreiben. Verbinde nur Geräte, die dir gehören.
              </Bullet>
              <Button
                title="Zahlen stimmen überein"
                icon="✅"
                busy={flow.step === 'sending'}
                onPress={() => {
                  if (flow.step === 'linking') void send(compareCode, flow.expiresAt);
                }}
              />
              <Button title="Abbrechen" kind="secondary" disabled={flow.step === 'sending'} onPress={() => cancelLink(true)} />
            </Card>
          ) : flow.step === 'sent' ? (
            <Card style={{ gap: spacing.md }}>
              {newDevice ? (
                <Banner tone="success" title={`„${newDevice.name}“ ist verbunden`}>
                  Ab jetzt bleiben beide Geräte auf demselben Stand.
                </Banner>
              ) : (
                <Banner tone="success" title="Gesendet">
                  Dein Konto ist verschlüsselt unterwegs. Bestätige auch auf dem neuen Gerät die Zahlen und dass es dein Konto ist. Danach taucht es hier in der Liste auf.
                </Banner>
              )}
              <Button title="Fertig" kind="secondary" compact onPress={() => setFlow({ step: 'idle' })} />
            </Card>
          ) : flow.step === 'failed' ? (
            <Card style={{ gap: spacing.md }}>
              <Banner tone="danger" title="Hat nicht geklappt">
                {`${flow.error} Lass auf dem neuen Gerät einen neuen Code anzeigen und versuch es nochmal.`}
              </Banner>
              <Button title="Nochmal scannen" onPress={() => reset({ step: 'scan' })} />
              <Button title="Abbrechen" kind="ghost" compact onPress={() => reset({ step: 'idle' })} />
            </Card>
          ) : null}
        </Section>

        <Section title="Gerät verloren?">
          <Card style={{ gap: spacing.sm }}>
            <Bullet icon="⚠️">
              Entfernen heißt nur: Das Gerät bekommt keine Änderungen mehr von hier. Weil alle deine Geräte dasselbe Konto teilen, kann Heyda. ein verlorenes Gerät nicht aussperren. Meldet es sich wieder, taucht es erneut auf.
            </Bullet>
            <Bullet icon="🛟">
              Ist ein Gerät verloren oder gestohlen, sag deinen Freunden Bescheid. Dann richte ein neues Konto ein (Einstellungen → Alles löschen, dann „Neu starten“) und fügt euch neu hinzu.
            </Bullet>
          </Card>
        </Section>
      </Narrow>
    </Screen>
  );
}

function DeviceRow({ icon, name, detail, current, first, onRemove }: {
  icon: string;
  name: string;
  detail: string;
  current?: boolean;
  first?: boolean;
  onRemove?: () => void;
}) {
  const t = useTheme();
  return (
    <Row
      gap={spacing.md}
      style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md, minHeight: TOUCH + 16, borderTopWidth: first ? 0 : 1, borderTopColor: t.border }}
    >
      <Text style={{ fontSize: 26 }} accessible={false}>
        {icon}
      </Text>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="h2">{name}</T>
        <T variant="small">{detail}</T>
      </View>
      {current ? (
        <Pill text="Dieses Gerät" color={t.success} />
      ) : onRemove ? (
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={`${name} entfernen`}
          style={{ minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: spacing.sm }}
        >
          <Text style={{ color: t.danger, fontWeight: '700' }}>Entfernen</Text>
        </Pressable>
      ) : null}
    </Row>
  );
}
