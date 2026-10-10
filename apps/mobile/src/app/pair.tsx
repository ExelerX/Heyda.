import { INVITE_TTL_MS, type Contact } from '@fastda/core';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { QrCode } from '../components/QrCode';
import { Button, Card, Chip, Hint, Row, Screen, T } from '../components/ui';
import { timeLeft } from '../lib/format';
import { useRuntime, useSnapshot, useTick } from '../lib/store';
import { radius, spacing, useTheme } from '../lib/theme';

type Mode = 'show' | 'scan';

export default function Pair() {
  const runtime = useRuntime();
  const { state } = useSnapshot();
  const [mode, setMode] = useState<Mode>('show');
  const [added, setAdded] = useState<Contact>();
  const known = useRef(new Set(state.contacts.map((c) => c.key)));

  // Someone scanned my code: their hello arrives and they show up as a new contact.
  useEffect(() => {
    const fresh = state.contacts.find((c) => !known.current.has(c.key));
    if (fresh) setAdded(fresh);
  }, [state.contacts]);

  if (added) return <Added contact={added} safety={runtime.safetyNumberWith(added.key)} />;

  return (
    <Screen edges={['bottom']}>
      <Row>
        <Chip label="Mein Code" icon="📱" selected={mode === 'show'} onPress={() => setMode('show')} />
        <Chip label="Code scannen" icon="📷" selected={mode === 'scan'} onPress={() => setMode('scan')} />
      </Row>
      {mode === 'show' ? <ShowCode /> : <ScanCode onAdded={setAdded} />}
    </Screen>
  );
}

function ShowCode() {
  const runtime = useRuntime();
  const now = useTick(1000);
  const [invite, setInvite] = useState(() => ({ text: runtime.createInvite(), expiresAt: Date.now() + INVITE_TTL_MS }));
  const expired = now >= invite.expiresAt;

  return (
    <View style={{ gap: spacing.lg, marginTop: spacing.md }}>
      <T variant="muted">Lass die andere Person diesen Code mit ihrer App scannen. Am besten, wenn ihr nebeneinander steht.</T>
      {expired ? (
        <Card style={{ alignItems: 'center' }}>
          <T variant="h2">Code abgelaufen</T>
        </Card>
      ) : (
        <QrCode value={invite.text} label="Dein Einladungs-Code" />
      )}
      <T variant="small" style={{ textAlign: 'center' }}>
        {expired ? 'Aus Sicherheitsgründen gilt jeder Code nur 10 Minuten.' : `Nur einmal gültig · ${timeLeft(invite.expiresAt, now)}`}
      </T>
      <Button
        title="Neuer Code"
        kind="secondary"
        onPress={() => setInvite({ text: runtime.createInvite(), expiresAt: Date.now() + INVITE_TTL_MS })}
      />
    </View>
  );
}

function ScanCode({ onAdded }: { onAdded: (c: Contact) => void }) {
  const t = useTheme();
  const runtime = useRuntime();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string>();
  const [pasted, setPasted] = useState('');
  const busy = useRef(false);
  const web = Platform.OS === 'web';

  async function accept(text: string) {
    if (busy.current) return;
    busy.current = true;
    setError(undefined);
    try {
      onAdded(await runtime.acceptInvite(text.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Code');
      setTimeout(() => (busy.current = false), 1500);
    }
  }

  if (web) {
    return (
      <View style={{ gap: spacing.md, marginTop: spacing.md }}>
        <Hint>Im Browser gibt es keinen Scanner. Füge den Code-Text ein (beginnt mit „fastda:1:“).</Hint>
        <TextInput
          value={pasted}
          onChangeText={setPasted}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="fastda:1:…"
          placeholderTextColor={t.textMuted}
          accessibilityLabel="Einladungs-Code"
          style={{ backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: radius.md, color: t.text, padding: spacing.md }}
        />
        {error && <T color={t.danger}>{error}</T>}
        <Button title="Hinzufügen" onPress={() => void accept(pasted)} disabled={!pasted.trim()} />
      </View>
    );
  }

  if (!permission?.granted) {
    return (
      <View style={{ gap: spacing.md, marginTop: spacing.md }}>
        <T variant="muted">Die Kamera wird nur zum Scannen des Codes benutzt. Es werden keine Bilder gespeichert.</T>
        <Button title="Kamera erlauben" icon="📷" onPress={() => void requestPermission()} />
      </View>
    );
  }

  return (
    <View style={{ gap: spacing.md, marginTop: spacing.md }}>
      <View style={{ borderRadius: radius.lg, overflow: 'hidden', aspectRatio: 1, borderWidth: 2, borderColor: t.accent }}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => void accept(data)}
        />
      </View>
      {error ? <T color={t.danger}>{error}</T> : <T variant="small">Halte die Kamera auf den Code der anderen Person.</T>}
    </View>
  );
}

function Added({ contact, safety }: { contact: Contact; safety: string }) {
  const t = useTheme();
  return (
    <Screen edges={['bottom']}>
      <T variant="title">🎉 {contact.name} ist dabei</T>
      <T variant="muted">
        Vergleicht jetzt kurz eure Sicherheitsnummer. Stimmt sie auf beiden Handys überein, kann sich niemand dazwischen
        geschaltet haben.
      </T>
      <Card style={{ alignItems: 'center' }}>
        <T style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 22, letterSpacing: 2, textAlign: 'center' }} color={t.text}>
          {safety}
        </T>
      </Card>
      <View style={{ gap: spacing.md, marginTop: spacing.lg }}>
        <Button title="Zum Kontakt" onPress={() => router.replace(`/contact/${contact.key}`)} />
        <Button title="Fertig" kind="secondary" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}
