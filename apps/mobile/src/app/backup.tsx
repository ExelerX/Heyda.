import { BACKUP_MIN_PASSWORD } from '@heyda/core';
import { Stack } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { passwordStrength } from '../components/setup/password';
import { Banner, Bullet, errorText, Narrow, PasswordField, ProgressBar } from '../components/setup/kit';
import { canPickFiles, RestoreFlow } from '../components/setup/RestoreFlow';
import { Button, Card, Screen, Section, T } from '../components/ui';
import { saveBackupFile } from '../lib/files';
import { useRuntime, useSnapshot } from '../lib/store';
import { spacing, useTheme } from '../lib/theme';

export default function Backup() {
  const { isDemo } = useSnapshot();
  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Sicherung' }} />
      <Narrow>
        <T variant="muted">
          Eine Sicherung ist eine verschlüsselte Datei mit deinem Konto. Damit ziehst du auf ein neues Handy um oder holst alles zurück, wenn dein Handy kaputtgeht.
        </T>

        <Section title="Was drin ist">
          <Card style={{ gap: spacing.sm }}>
            <Bullet icon="🔑">Dein Konto, damit dich deine Freunde wiedererkennen</Bullet>
            <Bullet icon="👥">Kontakte und Gruppen, mit Spitznamen und Notfallkontakten</Bullet>
            <Bullet icon="📍">Orte und wer dort Bescheid bekommt</Bullet>
            <Bullet icon="⚡">Automationen und Plugins</Bullet>
            <Bullet icon="⚙️">Einstellungen, Ruhezeiten und dein Notruf-Text</Bullet>
            <Bullet icon="💬">Die letzten 100 Nachrichten pro Chat (ältere nicht)</Bullet>
            <Bullet icon="⏸️">Nicht drin: Live-Standort und Notruf, die gerade laufen. Sie starten nach dem Wiederherstellen nicht von selbst.</Bullet>
            <Bullet icon="🔒">
              Ohne dein Passwort kann niemand die Datei öffnen, auch wir nicht. Vergisst du es, ist die Sicherung verloren. Schreib es dir auf.
            </Bullet>
          </Card>
        </Section>

        <Section title="Sicherung erstellen">{isDemo ? <DemoNote /> : <CreateBackup />}</Section>

        <Section title="Sicherung wiederherstellen">
          {canPickFiles ? (
            <RestoreFlow warnReplace />
          ) : (
            <Banner tone="info" title="Nur in der App">
              In der Web-Vorschau kann keine Datei geöffnet werden. Auf dem Handy oder in der Windows-App geht das.
            </Banner>
          )}
        </Section>
      </Narrow>
    </Screen>
  );
}

function DemoNote() {
  return (
    <Banner tone="info" title="Im Demo-Modus nicht möglich">
      In der Demo gibt es nichts Echtes zu sichern. Beende die Demo unter „Ich“, um dein eigenes Konto anzulegen.
    </Banner>
  );
}

function CreateBackup() {
  const t = useTheme();
  const runtime = useRuntime();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [progress, setProgress] = useState<number>();
  const [result, setResult] = useState<'saved' | 'cancelled'>();
  const [error, setError] = useState<string>();
  const running = useRef(false);

  const strength = passwordStrength(password);
  const long = [...password].length >= BACKUP_MIN_PASSWORD;
  const same = password === repeat;
  const ready = long && same && progress === undefined;
  const strengthColor = [t.danger, t.danger, t.accent, t.success][strength.level];

  async function create() {
    if (!ready || running.current) return;
    running.current = true;
    setError(undefined);
    setResult(undefined);
    setProgress(0);
    try {
      const bytes = await runtime.exportBackup(password, (f) => setProgress(f));
      setProgress(1);
      const saved = await saveBackupFile(bytes);
      setResult(saved ? 'saved' : 'cancelled');
      if (saved) {
        setPassword('');
        setRepeat('');
      }
    } catch (e) {
      setError(errorText(e, 'Die Sicherung konnte nicht erstellt werden.'));
    } finally {
      setProgress(undefined);
      running.current = false;
    }
  }

  return (
    <Card style={{ gap: spacing.md }}>
      <PasswordField
        label="Passwort für die Sicherung"
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          setResult(undefined);
        }}
        hint={`Mindestens ${BACKUP_MIN_PASSWORD} Zeichen. Nimm nicht deine Handy-PIN.`}
      />
      {password.length > 0 && (
        <View style={{ gap: 2 }} accessible accessibilityLabel={`Passwortstärke: ${strength.label}. ${strength.tip}`}>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {[1, 2, 3].map((i) => (
              <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: strength.level >= i ? strengthColor : t.surfaceRaised }} />
            ))}
          </View>
          <T variant="small" color={strengthColor}>{`${strength.label}: ${strength.tip}`}</T>
        </View>
      )}
      <PasswordField
        label="Passwort wiederholen"
        value={repeat}
        onChangeText={setRepeat}
        error={repeat.length > 0 && !same ? 'Die Passwörter sind nicht gleich.' : undefined}
        onSubmitEditing={() => void create()}
      />
      {progress !== undefined && <ProgressBar value={progress} label="Verschlüssele…" />}
      {error && (
        <Banner tone="danger" title="Hat nicht geklappt">
          {error}
        </Banner>
      )}
      {result === 'saved' && (
        <Banner tone="success" title="Sicherung gespeichert">
          Bewahre die Datei gut auf, z. B. in deiner Cloud oder auf einem USB-Stick, und das Passwort getrennt davon.
        </Banner>
      )}
      {result === 'cancelled' && (
        <Banner tone="warn" title="Nicht gespeichert">
          Du hast das Speichern abgebrochen. Versuch es nochmal, wenn du so weit bist.
        </Banner>
      )}
      <Button title="Sicherung erstellen" icon="💾" onPress={() => void create()} disabled={!ready} busy={progress !== undefined} />
      <T variant="small">
        Wer die Datei und das Passwort hat, kann dein Konto übernehmen. Gib beides nicht weiter.
      </T>
    </Card>
  );
}
