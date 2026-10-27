import Constants from 'expo-constants';
import { router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Banner, Bullet, errorText, Field, MONO, Narrow } from '../components/setup/kit';
import { Button, Card, Chip, Row, Screen, Section, T, Toggle, Wrap } from '../components/ui';
import { notice } from '../lib/confirm';
import { smsAvailable } from '../lib/emergency';
import { isIgnoringBatteryOptimizations, keepAliveSupported, openBatteryOptimizationSettings } from '../lib/keepalive';
import { desktop, isBrowserPreview, isDesktop, isNative } from '../lib/platform';
import appConfig from '../../app.json';
import { useRestart, useRuntime, useSnapshot } from '../lib/store';
import { spacing, useTheme, type Appearance } from '../lib/theme';

const APPEARANCES: { value: Appearance; label: string; icon: string }[] = [
  { value: 'dark', label: 'Dunkel', icon: '🌙' },
  { value: 'light', label: 'Hell', icon: '☀️' },
  { value: 'system', label: 'Wie das System', icon: '📱' },
];

const DEVICE_NAME_MAX = 40;
const WIPE_WORD = 'LÖSCHEN';

export default function Settings() {
  const t = useTheme();
  const runtime = useRuntime();
  const restart = useRestart();
  const { state, settings, isDemo } = useSnapshot();
  const [deviceName, setDeviceName] = useState(state.self.deviceName);
  const [sms, setSms] = useState<boolean>();
  const [batteryOk, setBatteryOk] = useState(true);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [wiping, setWiping] = useState(false);

  useEffect(() => {
    void smsAvailable().then(setSms).catch(() => setSms(false));
    if (keepAliveSupported) void isIgnoringBatteryOptimizations().then(setBatteryOk).catch(() => {});
  }, []);

  // Native builds report their real version; the web bundle's embedded manifest can be stale, so use app.json there.
  const version = (isNative ? Constants.expoConfig?.version : undefined) ?? appConfig.expo.version;
  const appearance = settings.appearance ?? 'dark';
  const cleanDevice = deviceName.trim();
  const otherDevices = state.devices.filter((d) => d.deviceId !== state.self.deviceId).length;
  const wipeReady = typed.trim().toLocaleUpperCase('de-DE') === WIPE_WORD;

  function saveDeviceName() {
    if (!cleanDevice) return;
    runtime.node.setDeviceName(cleanDevice);
    notice('Gespeichert', `Dieses Gerät heißt jetzt „${cleanDevice}“.`);
  }

  async function wipe() {
    if (!wipeReady) return;
    setWiping(true);
    try {
      await runtime.wipeEverything();
      await restart();
    } catch (e) {
      notice('Löschen hat nicht geklappt', errorText(e));
      setWiping(false);
    }
  }

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Einstellungen' }} />
      <Narrow>
        <Section title="Aussehen">
          <Wrap>
            {APPEARANCES.map((a) => (
              <Chip key={a.value} icon={a.icon} label={a.label} selected={appearance === a.value} onPress={() => runtime.setAppearance(a.value)} />
            ))}
          </Wrap>
          <T variant="small">Dunkel ist Standard und schont nachts die Augen.</T>
        </Section>

        <Section title="Karte">
          <Card>
            <Toggle
              label="🗺️ Karten anzeigen"
              detail="Die Kartenbilder kommen von OpenStreetMap. Dabei sieht OpenStreetMap deine Internet-Adresse und ungefähr, welche Gegend du dir anschaust – auch, wo ein Freund gerade ist, wenn du ihn auf der Karte ansiehst. Ohne Karte funktioniert alles andere genauso."
              value={settings.mapEnabled}
              onChange={(v) => runtime.updateSettings({ mapEnabled: v })}
            />
          </Card>
        </Section>

        <Section title="Notruf">
          <Card>
            <Toggle
              label="📩 SMS als Rückfallebene"
              detail="Nach einem Notruf öffnet sich zusätzlich eine fertige SMS mit deinem Standort an die Telefonnummern deiner Notfallkontakte. Hilft, wenn das Internet weg ist. Du tippst nur noch auf Senden."
              value={settings.smsFallback}
              onChange={(v) => runtime.updateSettings({ smsFallback: v })}
            />
            {sms === false && (
              <T variant="small" color={t.accent}>
                {isDesktop || isBrowserPreview ? 'Auf diesem Gerät gibt es keine SMS. Das klappt nur auf dem Handy.' : 'Dieses Gerät kann gerade keine SMS senden.'}
              </T>
            )}
            <Button title="Notfall-Einstellungen" kind="ghost" compact onPress={() => router.push('/safety')} />
          </Card>
        </Section>

        {keepAliveSupported && (
          <Section title="Im Hintergrund">
            <Card>
              <Toggle
                label="📶 Verbunden bleiben"
                detail="Empfohlen. Notrufe und Nachrichten kommen sofort an, auch wenn die App zu ist. Android zeigt dafür eine kleine, dauerhafte Benachrichtigung."
                value={settings.keepAlive}
                onChange={(v) => runtime.updateSettings({ keepAlive: v })}
              />
              {settings.keepAlive && !batteryOk && (
                <>
                  <T variant="small">Dein Handy könnte Heyda. trotzdem beenden, um Akku zu sparen. Stell Heyda. auf „Nicht optimieren“.</T>
                  <Button
                    title="Akku-Einstellungen öffnen"
                    kind="ghost"
                    compact
                    onPress={() => void openBatteryOptimizationSettings().catch(() => notice('Konnte die Einstellungen nicht öffnen'))}
                  />
                </>
              )}
            </Card>
          </Section>
        )}

        <Section title="Dieses Gerät">
          <Card style={{ gap: spacing.md }}>
            <Field
              label="Gerätename"
              value={deviceName}
              onChangeText={setDeviceName}
              maxLength={DEVICE_NAME_MAX}
              hint="So heißt dieses Gerät in „Meine Geräte“ auf deinen anderen Geräten. Deine Freunde sehen ihn nicht."
              onSubmitEditing={saveDeviceName}
            />
            <Button title="Namen speichern" kind="secondary" compact onPress={saveDeviceName} disabled={!cleanDevice || cleanDevice === state.self.deviceName} />
            <Button title="Meine Geräte" kind="ghost" compact onPress={() => router.push('/devices')} />
          </Card>
        </Section>

        <Section title="Über Heyda.">
          <Card style={{ gap: spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="h2">Heyda.</T>
              <T variant="small">{`Version ${version}${desktop ? ` · Windows-App ${desktop.version}` : ''}`}</T>
            </Row>
            <T variant="muted">Open Source unter der Apache-2.0-Lizenz. Kostenlos, ohne Werbung, ohne Tracking, ohne Konto.</T>
            <T variant="h2">Wo deine Daten sind</T>
            <Bullet icon="📱">Auf deinem Gerät, verschlüsselt: Kontakte, Chats, Orte, Automationen, Einstellungen und dein geheimer Schlüssel.</Bullet>
            <Bullet icon="✉️">Unterwegs: nur verschlüsselte Nachrichten an deine Kontakte, über öffentliche Weiterleitungs-Server. Die sehen nicht, was drinsteht oder von wem es kommt.</Bullet>
            <Bullet icon="🗺️">{`Kartenbilder: von OpenStreetMap, nur wenn die Karte an ist (gerade ${settings.mapEnabled ? 'an' : 'aus'}).`}</Bullet>
            <Bullet icon="🏢">Bei uns: nichts. Es gibt keinen Heyda.-Server und keine Statistik über dich.</Bullet>
            <View style={{ gap: spacing.xs }}>
              <T variant="small">Deine Kennung (zum Abgleichen mit Freunden):</T>
              <T style={{ fontFamily: MONO, fontSize: 13 }} color={t.textMuted}>
                {`${state.self.key.slice(0, 8)} … ${state.self.key.slice(-8)}`}
              </T>
            </View>
          </Card>
        </Section>

        <Section title="Gefahrenzone">
          <Card style={{ borderColor: t.danger, gap: spacing.md }}>
            <T variant="h2" color={t.danger}>
              ⛔ Alles löschen
            </T>
            <T variant="muted">
              {isDemo
                ? 'Löscht die Demo und alles, was du darin ausprobiert hast, von diesem Gerät.'
                : 'Löscht dein Konto, Kontakte, Chats, Orte und Automationen von diesem Gerät. Das lässt sich nicht rückgängig machen.'}
            </T>
            {!wipeOpen ? (
              <Button title="Alles löschen …" kind="danger" onPress={() => setWipeOpen(true)} />
            ) : (
              <View style={{ gap: spacing.md }}>
                {!isDemo && (
                  <Banner tone="warn" title="Vorher sichern?">
                    Ohne Sicherung sind deine Kontakte weg, und deine Freunde müssen dich neu hinzufügen.
                  </Banner>
                )}
                {!isDemo && <Button title="Erst eine Sicherung machen" kind="secondary" compact onPress={() => router.push('/backup')} />}
                {otherDevices > 0 && !isDemo ? (
                  <T variant="small">{`Auf deinen anderen Geräten (${otherDevices}) bleibt dein Konto erhalten. Lösche es dort extra, wenn du willst.`}</T>
                ) : null}
                <Field
                  label={`Tippe ${WIPE_WORD} zur Bestätigung`}
                  value={typed}
                  onChangeText={setTyped}
                  placeholder={WIPE_WORD}
                  autoCapitalize="characters"
                  maxLength={20}
                />
                <Button title="Endgültig löschen" kind="danger" onPress={() => void wipe()} disabled={!wipeReady} busy={wiping} />
                <Button
                  title="Abbrechen"
                  kind="ghost"
                  compact
                  onPress={() => {
                    setWipeOpen(false);
                    setTyped('');
                  }}
                />
              </View>
            )}
          </Card>
        </Section>
      </Narrow>
    </Screen>
  );
}
