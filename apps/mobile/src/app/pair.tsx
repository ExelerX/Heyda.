import { decodeInvite, INVITE_TTL_MS } from '@heyda/core';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, useWindowDimensions, View } from 'react-native';
import { errorText } from '../components/social/format';
import { Field, Narrow, Segmented } from '../components/social/kit';
import { LIMITS } from '../components/social/limits';
import { QrCode } from '../components/QrCode';
import { Button, Card, Hint, Row, Screen, T } from '../components/ui';
import { isDesktop, isNative } from '../lib/platform';
import { useRuntime, useSnapshot } from '../lib/store';
import { useNow } from '../components/social/useNow';
import { radius, spacing, useTheme } from '../lib/theme';

type Tab = 'show' | 'scan';

const openContact = (key: string) => router.replace({ pathname: '/contact/[key]', params: { key, added: '1' } });

export default function Pair() {
  const { state, isDemo } = useSnapshot();
  const [tab, setTab] = useState<Tab>('show');
  const known = useRef(new Set(state.contacts.map((c) => c.key)));

  // Someone scanned my code: their confirmation arrives and they show up as a new contact.
  useEffect(() => {
    const fresh = state.contacts.find((c) => !known.current.has(c.key));
    if (fresh && tab === 'show') openContact(fresh.key);
    state.contacts.forEach((c) => known.current.add(c.key));
  }, [state.contacts, tab]);

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Freund hinzufügen' }} />
      <Narrow>
        <Segmented
          options={[
            { key: 'show', label: '📱 Mein Code' },
            { key: 'scan', label: '📷 Code scannen' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <Hint>
          So geht’s: Einer zeigt seinen Code, der andere scannt ihn – das reicht. Wer scannt, hat den anderen sofort in den
          Kontakten; beim Handy mit dem Code kommt die Bestätigung ein paar Sekunden später an (es braucht Internet). Jeder Code
          gilt 10 Minuten und nur einmal.
        </Hint>
        {isDemo ? (
          <T variant="small">🧪 Im Demo-Modus sind Lisa, Max und Oma Ilse schon da. Hier kannst du dir den Ablauf ansehen.</T>
        ) : null}
        {tab === 'show' ? <ShowCode /> : <ScanCode />}
      </Narrow>
    </Screen>
  );
}

function ShowCode() {
  const t = useTheme();
  const runtime = useRuntime();
  const { width } = useWindowDimensions();
  const now = useNow(1000);
  const [invite, setInvite] = useState(() => ({ text: runtime.node.createInvite(), expiresAt: Date.now() + INVITE_TTL_MS }));
  const [copied, setCopied] = useState(false);
  const left = invite.expiresAt - now;
  const expired = left <= 0;
  const size = Math.max(180, Math.min(280, width - 96));

  const renew = () => {
    setInvite({ text: runtime.node.createInvite(), expiresAt: Date.now() + INVITE_TTL_MS });
    setCopied(false);
  };

  async function copy() {
    try {
      await Clipboard.setStringAsync(invite.text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const mmss = `${Math.floor(Math.max(0, left) / 60_000)}:${String(Math.floor((Math.max(0, left) % 60_000) / 1000)).padStart(2, '0')}`;

  return (
    <View style={{ gap: spacing.md }}>
      <T variant="muted">Lass deinen Freund diesen Code mit Heyda. scannen. Am besten, wenn ihr nebeneinander steht.</T>
      {expired ? (
        <Card style={{ alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl }}>
          <T variant="h2">⌛ Code abgelaufen</T>
          <T variant="small" style={{ textAlign: 'center' }}>
            Aus Sicherheitsgründen gilt jeder Code nur 10 Minuten.
          </T>
          <Button title="Neuen Code zeigen" onPress={renew} />
        </Card>
      ) : (
        <>
          <QrCode value={invite.text} size={size} label={`Dein Kontakt-Code für Heyda., noch ${mmss} Minuten gültig`} />
          <Row style={{ justifyContent: 'center' }} gap={spacing.sm}>
            <ActivityIndicator color={t.accent} size="small" />
            <T variant="small">{`Warte auf den Scan … noch ${mmss} gültig`}</T>
          </Row>
        </>
      )}
      <Row gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
        {!expired ? <Button title="Neuer Code" icon="🔄" kind="secondary" compact onPress={renew} style={{ flexGrow: 1 }} /> : null}
        {!expired ? (
          <Button
            title={copied ? 'Kopiert ✓' : 'Als Text kopieren'}
            icon="📋"
            kind="secondary"
            compact
            onPress={() => void copy()}
            style={{ flexGrow: 1 }}
          />
        ) : null}
      </Row>
      <T variant="small">
        Den Text brauchst du nur, wenn dein Freund den Code nicht scannen kann (z. B. am Computer). Schick ihn nur direkt an diese
        Person – wer den Text hat, kann sich einmal als Kontakt eintragen.
      </T>
    </View>
  );
}

function ScanCode() {
  const t = useTheme();
  const runtime = useRuntime();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState(!isNative);
  const last = useRef<{ data: string; at: number }>({ data: '', at: 0 });

  async function accept(raw: string, fromCamera = false) {
    const code = raw.trim();
    if (!code || busy) return;
    // The camera reports the same code many times per second.
    if (fromCamera && last.current.data === code && Date.now() - last.current.at < 3000) return;
    last.current = { data: code, at: Date.now() };
    setBusy(true);
    setError(undefined);
    try {
      const decoded = decodeInvite(code);
      const already = decoded.ok && runtime.getSnapshot().state.contacts.some((c) => c.key === decoded.invite.key);
      // Also for someone already added: it sends the confirmation again, in case they lost me.
      const contact = await runtime.node.acceptInvite(code);
      if (already) router.replace({ pathname: '/contact/[key]', params: { key: contact.key } });
      else openContact(contact.key);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  async function pasteFromClipboard() {
    try {
      const s = await Clipboard.getStringAsync();
      if (s) {
        setText(s.slice(0, LIMITS.invite));
        void accept(s);
      }
    } catch {
      setError('Die Zwischenablage konnte nicht gelesen werden. Füge den Text von Hand ein.');
    }
  }

  return (
    <View style={{ gap: spacing.md }}>
      {isNative ? <NativeScanner onCode={(d) => void accept(d, true)} onDenied={() => setPaste(true)} busy={busy} /> : null}
      {!isNative ? (
        <Hint>
          {isDesktop
            ? 'Am Computer gibt es keinen Scanner. Lass dir den Code als Text schicken („Als Text kopieren“ beim anderen) und füge ihn hier ein.'
            : 'Hier gibt es keinen Scanner. Füge den Code als Text ein (beginnt mit „heyda:1:“).'}
        </Hint>
      ) : null}

      {error ? (
        <Card style={{ borderColor: t.danger }}>
          <T color={t.danger}>{`⚠️ ${error}`}</T>
        </Card>
      ) : null}

      {paste ? (
        <View style={{ gap: spacing.sm }}>
          <Field
            label="Code als Text"
            value={text}
            onChangeText={(v) => {
              setText(v);
              setError(undefined);
            }}
            maxLength={LIMITS.invite}
            placeholder="heyda:1:…"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          <Row gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
            <Button title="Hinzufügen" icon="🤝" onPress={() => void accept(text)} disabled={!text.trim()} busy={busy} style={{ flexGrow: 1 }} />
            <Button title="Einfügen" icon="📋" kind="secondary" onPress={() => void pasteFromClipboard()} style={{ flexGrow: 1 }} />
          </Row>
        </View>
      ) : (
        <Button title="Code stattdessen als Text einfügen" kind="ghost" compact onPress={() => setPaste(true)} />
      )}
    </View>
  );
}

function NativeScanner({ onCode, onDenied, busy }: { onCode: (data: string) => void; onDenied: () => void; busy: boolean }) {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const denied = permission && !permission.granted && !permission.canAskAgain;

  useEffect(() => {
    if (denied) onDenied();
  }, [denied]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!permission) return <ActivityIndicator color={t.accent} />;
  if (!permission.granted) {
    return (
      <Card style={{ gap: spacing.md }}>
        <T variant="h2">📷 Kamera zum Scannen</T>
        <T variant="muted">Die Kamera wird nur zum Lesen des Codes benutzt. Es werden keine Bilder gespeichert oder verschickt.</T>
        {denied ? (
          <T variant="small">Der Kamerazugriff ist in den Einstellungen deines Handys ausgeschaltet. Du kannst den Code unten auch als Text einfügen.</T>
        ) : (
          <Button title="Kamera erlauben" icon="📷" onPress={() => void requestPermission()} />
        )}
      </Card>
    );
  }
  return (
    <View style={{ gap: spacing.sm }}>
      <View
        style={{
          borderRadius: radius.lg,
          overflow: 'hidden',
          aspectRatio: 1,
          width: '100%',
          maxWidth: 420,
          alignSelf: 'center',
          borderWidth: 2,
          borderColor: t.accent,
        }}
      >
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={busy ? undefined : ({ data }) => onCode(data)}
          accessibilityLabel="Kamera-Vorschau zum Scannen des Codes"
        />
        {busy ? (
          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
            <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg, opacity: 0.5 }]} />
            <ActivityIndicator color={t.accent} size="large" />
          </View>
        ) : null}
      </View>
      <T variant="small" style={{ textAlign: 'center' }}>
        Halte die Kamera auf den Code deines Freundes.
      </T>
    </View>
  );
}
