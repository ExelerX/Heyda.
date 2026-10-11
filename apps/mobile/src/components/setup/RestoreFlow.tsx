import { decryptBackup } from '@heyda/core';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { confirm, notice } from '../../lib/confirm';
import { pickBackupFile } from '../../lib/files';
import { desktop, isNative } from '../../lib/platform';
import { restoreBackup } from '../../lib/runtime';
import { useRestart, useRuntime } from '../../lib/store';
import { spacing, useTheme } from '../../lib/theme';
import { Button, Card, T } from '../ui';
import { Banner, errorText, PasswordField, ProgressBar } from './kit';

/** Picking a file needs the Windows app or a phone; the browser preview has nowhere to read from. */
export const canPickFiles = desktop !== undefined || isNative;

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} Byte` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Restores an encrypted backup: pick the file, enter the password, wait for the key
 * derivation, then the app restarts with the restored account.
 */
export function RestoreFlow({ warnReplace }: { warnReplace: boolean }) {
  const t = useTheme();
  const runtime = useRuntime();
  const restart = useRestart();
  const [file, setFile] = useState<Uint8Array>();
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<'idle' | 'picking' | 'checking' | 'writing' | 'done'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string>();
  const running = useRef(false);

  async function pick() {
    setError(undefined);
    setPhase('picking');
    try {
      const bytes = await pickBackupFile();
      if (bytes) setFile(bytes);
    } catch (e) {
      setError(errorText(e, 'Die Datei konnte nicht geöffnet werden.'));
    } finally {
      setPhase('idle');
    }
  }

  async function restore() {
    if (!file || !password || running.current) return;
    if (warnReplace) {
      const ok = await confirm({
        title: 'Alles auf diesem Gerät ersetzen?',
        message: 'Kontakte, Chats, Orte, Automationen und dein Konto auf diesem Gerät werden durch die Sicherung ersetzt. Das lässt sich nicht rückgängig machen.',
        ok: 'Ersetzen',
        destructive: true,
      });
      if (!ok) return;
    }
    running.current = true;
    setError(undefined);
    setProgress(0);
    setPhase('checking');
    let stopped = false;
    try {
      // Check the password first, so a typo never touches the running app.
      const check = await decryptBackup(file, password, (f) => setProgress(f));
      if (!check.ok) {
        setError(check.error);
        setPhase('idle');
        return;
      }
      // Stop the running app before its data is replaced, so it cannot save over the restored data.
      await runtime.shutdown(false);
      stopped = true;
      setPhase('writing');
      setProgress(0);
      const r = await restoreBackup(file, password, (f) => setProgress(f));
      if (!r.ok) {
        // The app restarts with the old data; this screen is rebuilt, so say it in a dialog.
        notice('Wiederherstellen hat nicht geklappt', r.error);
        await restart();
        return;
      }
      setPhase('done');
      await restart();
      try {
        router.replace('/');
      } catch {
        // The app restarted at the start screen already.
      }
    } catch (e) {
      const message = errorText(e, 'Die Sicherung konnte nicht wiederhergestellt werden.');
      setError(message);
      setPhase('idle');
      if (stopped) {
        notice('Wiederherstellen hat nicht geklappt', message);
        await restart().catch(() => {});
      }
    } finally {
      running.current = false;
    }
  }

  if (!canPickFiles) {
    return (
      <Banner tone="info" title="Nur in der App">
        In der Web-Vorschau kann keine Datei geöffnet werden. Auf dem Handy oder in der Windows-App geht das.
      </Banner>
    );
  }

  const busy = phase === 'checking' || phase === 'writing' || phase === 'done';
  return (
    <Card style={{ gap: spacing.md }}>
      {warnReplace && (
        <Banner tone="warn" title="Ersetzt alles auf diesem Gerät">
          Das Konto, die Kontakte, Chats, Orte und Automationen auf diesem Gerät werden durch die Sicherung ersetzt.
        </Banner>
      )}
      <View style={{ gap: spacing.sm }}>
        <T variant="h2">1. Datei wählen</T>
        {file ? (
          <T variant="muted">{`📄 Sicherung gewählt (${sizeText(file.length)})`}</T>
        ) : (
          <T variant="muted">Die Datei endet auf „.heyda“. Du hast sie beim Sichern gespeichert oder dir geschickt.</T>
        )}
        <Button
          title={file ? 'Andere Datei wählen' : 'Sicherungsdatei wählen'}
          icon="📂"
          kind="secondary"
          onPress={() => void pick()}
          busy={phase === 'picking'}
          disabled={busy}
        />
      </View>
      <View style={{ gap: spacing.sm }}>
        <T variant="h2">2. Passwort eingeben</T>
        <PasswordField
          label="Passwort der Sicherung"
          value={password}
          onChangeText={(v) => {
            setPassword(v);
            setError(undefined);
          }}
          onSubmitEditing={() => void restore()}
        />
      </View>
      {busy && (
        <ProgressBar
          value={phase === 'done' ? 1 : progress}
          label={phase === 'checking' ? 'Passwort wird geprüft…' : phase === 'writing' ? 'Daten werden eingerichtet…' : 'Fertig, die App startet neu…'}
        />
      )}
      {error && (
        <Banner tone="danger" title="Hat nicht geklappt">
          {`${error} Prüfe das Passwort (Groß- und Kleinschreibung) und ob es die richtige Datei ist.`}
        </Banner>
      )}
      <Button title="Wiederherstellen" icon="♻️" onPress={() => void restore()} busy={busy} disabled={!file || !password || busy} />
      <T variant="small" color={t.textMuted}>
        Das Entschlüsseln dauert ein paar Sekunden. Das ist Absicht: So kann niemand schnell viele Passwörter ausprobieren.
      </T>
    </Card>
  );
}
