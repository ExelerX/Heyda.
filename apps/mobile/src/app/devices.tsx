import type { LinkedDevice } from '@heyda/core';
import { Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Bullet, Digits, errorText, Narrow, Step } from '../components/setup/kit';
import { LinkScanner } from '../components/setup/LinkScanner';
import { Button, Card, Pill, Row, Screen, Section, T } from '../components/ui';
import { confirm, notice } from '../lib/confirm';
import { useRuntime, useSnapshot } from '../lib/store';
import { spacing, TOUCH, useTheme } from '../lib/theme';

type Flow = { step: 'idle' } | { step: 'scan'; error?: string } | { step: 'compare'; code: string; digits: string } | { step: 'sending'; code: string; digits: string } | { step: 'sent'; known: number } | { step: 'failed'; error: string };

function deviceIcon(name: string): string {
  return /pc|windows|computer|laptop|mac/i.test(name) ? '💻' : '📱';
}

function dateText(at: number): string {
  return new Date(at).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function Devices() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, isDemo } = useSnapshot();
  const [flow, setFlow] = useState<Flow>({ step: 'idle' });
  const others = state.devices.filter((d) => d.deviceId !== state.self.deviceId);
  const sendingRef = useRef(false);

  // After sending: the new device announces itself, then it shows up in the list.
  const newDevice = flow.step === 'sent' && others.length > flow.known ? others[others.length - 1] : undefined;
  useEffect(() => {
    if (flow.step !== 'sent') return;
    const id = setTimeout(() => setFlow((f) => (f.step === 'sent' ? { step: 'idle' } : f)), 5 * 60_000);
    return () => clearTimeout(id);
  }, [flow.step]);

  function check(text: string) {
    const r = runtime.node.previewLink(text.trim());
    if (r.ok) setFlow({ step: 'compare', code: text.trim(), digits: r.code });
    else setFlow({ step: 'scan', error: r.error });
  }

  async function send(code: string, digits: string) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setFlow({ step: 'sending', code, digits });
    try {
      await runtime.linkDevice(code);
      setFlow({ step: 'sent', known: others.length });
    } catch (e) {
      setFlow({ step: 'failed', error: errorText(e, 'Das Konto konnte nicht gesendet werden.') });
    } finally {
      sendingRef.current = false;
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
              <Step n={2}>Das neue Gerät zeigt einen QR-Code und 6 Zahlen.</Step>
              <Step n={3}>Scanne den Code hier oder füge den Code-Text ein. Dann vergleichst du die Zahlen.</Step>
              <Button title="Neues Gerät verbinden" icon="🔗" onPress={() => setFlow({ step: 'scan' })} />
            </Card>
          ) : flow.step === 'scan' ? (
            <Card style={{ gap: spacing.md }}>
              <LinkScanner onCode={check} error={flow.error} />
              <Button title="Abbrechen" kind="ghost" compact onPress={() => setFlow({ step: 'idle' })} />
            </Card>
          ) : flow.step === 'compare' || flow.step === 'sending' ? (
            <Card style={{ gap: spacing.md }}>
              <T variant="h2" style={{ textAlign: 'center' }}>
                Stimmen die Zahlen auf beiden Geräten überein?
              </T>
              <Digits value={flow.digits} label="Vergleichszahlen" />
              <Bullet icon="🔐">
                Nur wenn sie gleich sind, ist es wirklich dein neues Gerät. Es bekommt dein ganzes Konto und kann danach in deinem Namen schreiben. Verbinde nur Geräte, die dir gehören.
              </Bullet>
              <Button title="Ja, die Zahlen stimmen" icon="✅" onPress={() => void send(flow.code, flow.digits)} busy={flow.step === 'sending'} />
              <Button
                title="Nein, abbrechen"
                kind="secondary"
                disabled={flow.step === 'sending'}
                onPress={() => {
                  setFlow({ step: 'idle' });
                  notice('Abgebrochen', 'Gut so. Wenn die Zahlen nicht stimmen, könnte ein fremder Code dahinterstecken. Starte auf dem neuen Gerät eine neue Verbindung.');
                }}
              />
            </Card>
          ) : flow.step === 'sent' ? (
            <Card style={{ gap: spacing.md }}>
              {newDevice ? (
                <Banner tone="success" title={`„${newDevice.name}“ ist verbunden`}>
                  Ab jetzt bleiben beide Geräte auf demselben Stand.
                </Banner>
              ) : (
                <Banner tone="success" title="Gesendet">
                  Dein Konto ist verschlüsselt unterwegs. Auf dem neuen Gerät geht es gleich von selbst weiter, und es taucht hier in der Liste auf, sobald es sich meldet.
                </Banner>
              )}
              <Button title="Fertig" kind="secondary" compact onPress={() => setFlow({ step: 'idle' })} />
            </Card>
          ) : (
            <Card style={{ gap: spacing.md }}>
              <Banner tone="danger" title="Hat nicht geklappt">
                {`${flow.error} Lass auf dem neuen Gerät einen neuen Code anzeigen und versuch es nochmal.`}
              </Banner>
              <Button title="Nochmal scannen" onPress={() => setFlow({ step: 'scan' })} />
              <Button title="Abbrechen" kind="ghost" compact onPress={() => setFlow({ step: 'idle' })} />
            </Card>
          )}
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
