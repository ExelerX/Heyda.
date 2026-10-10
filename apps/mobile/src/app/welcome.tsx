import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { Button, Card, Row, Screen, T } from '../components/ui';
import { setupNotifications } from '../lib/notifications';
import { useRestart, useRuntime } from '../lib/store';
import { radius, spacing, useTheme } from '../lib/theme';

const POINTS = [
  { icon: '📍', title: 'Dein Standort bleibt bei dir', text: 'Freunde sehen nur „kommt in ca. 10 min“ oder einen groben Bereich. Nie mehr, als du erlaubst.' },
  { icon: '🔒', title: 'Ende-zu-Ende-verschlüsselt', text: 'Nur ihr könnt eure Nachrichten lesen. Es gibt keinen Server von uns und kein Konto.' },
  { icon: '⚡', title: 'Automationen ohne Code', text: 'Zum Beispiel: „Sag mir Bescheid, wenn Lisa den Supermarkt verlässt.“' },
];

export default function Welcome() {
  const t = useTheme();
  const runtime = useRuntime();
  const restart = useRestart();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'real' | 'demo'>();
  const web = Platform.OS === 'web';

  async function go(demo: boolean) {
    setBusy(demo ? 'demo' : 'real');
    await runtime.setDisplayName(name);
    runtime.finishOnboarding();
    if (!web) await setupNotifications();
    if (demo !== runtime.isDemo) {
      await runtime.setDemo(demo);
      await restart();
      return;
    }
    router.replace('/');
  }

  return (
    <Screen edges={['top', 'bottom']}>
      <T variant="title" style={{ marginTop: spacing.xl }}>
        Hallo 👋
      </T>
      <T variant="muted">Teile mit Familie und Freunden, wann du ankommst. Ohne dass jemand weiß, wo du gerade bist.</T>

      <View style={{ gap: spacing.md, marginTop: spacing.lg }}>
        {POINTS.map((p) => (
          <Card key={p.title}>
            <Row gap={spacing.md} style={{ alignItems: 'flex-start' }}>
              <T style={{ fontSize: 26 }}>{p.icon}</T>
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="h2">{p.title}</T>
                <T variant="muted">{p.text}</T>
              </View>
            </Row>
          </Card>
        ))}
      </View>

      <T variant="h2" style={{ marginTop: spacing.xl }}>
        Wie sollen dich andere sehen?
      </T>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Dein Vorname"
        placeholderTextColor={t.textMuted}
        maxLength={40}
        autoComplete="given-name"
        accessibilityLabel="Dein Vorname"
        style={{
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: radius.md,
          color: t.text,
          fontSize: 17,
          padding: spacing.lg,
        }}
      />

      <View style={{ gap: spacing.md, marginTop: spacing.lg }}>
        {!web && (
          <Button title="Los geht's" icon="🚀" onPress={() => void go(false)} busy={busy === 'real'} disabled={!name.trim() || !!busy} />
        )}
        <Button
          title={web ? 'Demo starten' : 'Erst mal ausprobieren (Demo)'}
          kind={web ? 'primary' : 'secondary'}
          onPress={() => void go(true)}
          busy={busy === 'demo'}
          disabled={!!busy}
        />
        <T variant="small" style={{ textAlign: 'center' }}>
          {web
            ? 'Die Web-Vorschau läuft nur als Demo mit zwei simulierten Freunden. Nichts verlässt deinen Browser.'
            : 'In der Demo spielst du mit zwei simulierten Freunden. Nichts verlässt dein Handy.'}
        </T>
      </View>
    </Screen>
  );
}
