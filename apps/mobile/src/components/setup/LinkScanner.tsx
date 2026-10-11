import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { isNative } from '../../lib/platform';
import { radius, spacing, useTheme } from '../../lib/theme';
import { Button, T } from '../ui';
import { Field } from './kit';

const CODE_MAX = 2000;

/**
 * Reads a device code: with the camera on phones, by pasting the text everywhere
 * (the Windows app and the browser have no camera access).
 */
export function LinkScanner({ onCode, error }: { onCode: (text: string) => void; error?: string }) {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [pasted, setPasted] = useState('');
  const lastScan = useRef<{ text: string; at: number }>(undefined);

  function scanned(text: string) {
    // The camera reports the same code many times per second.
    const now = Date.now();
    if (lastScan.current && lastScan.current.text === text && now - lastScan.current.at < 3000) return;
    lastScan.current = { text, at: now };
    onCode(text);
  }

  async function fromClipboard() {
    try {
      const text = (await Clipboard.getStringAsync()).trim().slice(0, CODE_MAX);
      if (text) {
        setPasted(text);
        onCode(text);
      }
    } catch {
      // Some browsers block clipboard reads; typing or pasting by hand still works.
    }
  }

  return (
    <View style={{ gap: spacing.md }}>
      {isNative &&
        (permission?.granted ? (
          <View style={{ gap: spacing.sm }}>
            <View style={{ borderRadius: radius.lg, overflow: 'hidden', aspectRatio: 1, borderWidth: 2, borderColor: t.accent, maxWidth: 420, width: '100%', alignSelf: 'center' }}>
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={({ data }) => scanned(data)}
              />
            </View>
            <T variant="small" style={{ textAlign: 'center' }}>
              Halte die Kamera auf den QR-Code des neuen Geräts.
            </T>
          </View>
        ) : (
          <View style={{ gap: spacing.sm }}>
            <T variant="muted">Die Kamera wird nur zum Scannen des Codes benutzt. Es werden keine Bilder gespeichert.</T>
            {permission && !permission.canAskAgain ? (
              <>
                <T variant="small">Die Kamera ist blockiert. Erlaube sie in den Systemeinstellungen oder füge unten den Code-Text ein.</T>
                <Button title="Systemeinstellungen öffnen" kind="secondary" compact onPress={() => void Linking.openSettings().catch(() => {})} />
              </>
            ) : (
              <Button title="Kamera erlauben" icon="📷" onPress={() => void requestPermission()} />
            )}
          </View>
        ))}

      <View style={{ gap: spacing.sm }}>
        <T variant="h2">{isNative ? 'Oder Code-Text einfügen' : 'Code-Text einfügen'}</T>
        {!isNative && (
          <T variant="muted">Hier gibt es keine Kamera. Tippe auf dem neuen Gerät auf „Code-Text kopieren“ und füge ihn hier ein, z. B. über eine Nachricht an dich selbst.</T>
        )}
        <Field
          value={pasted}
          onChangeText={(v) => setPasted(v.slice(0, CODE_MAX))}
          placeholder="heyda-link:1:…"
          autoCapitalize="none"
          mono
          multiline
          minHeight={80}
          error={error}
        />
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Button title="Einfügen" icon="📋" kind="secondary" compact onPress={() => void fromClipboard()} style={{ flex: 1 }} />
          <Button title="Prüfen" compact onPress={() => onCode(pasted)} disabled={!pasted.trim()} style={{ flex: 1 }} />
        </View>
      </View>
    </View>
  );
}
