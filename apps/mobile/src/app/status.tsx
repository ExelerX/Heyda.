import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BigButton } from '../components/safety/BigButton';
import { Field } from '../components/safety/Field';
import { clockWithDay, inTime } from '../components/safety/time';
import { Button, Card, Chip, Row, Screen, Section, T, Wrap } from '../components/ui';
import { notice } from '../lib/confirm';
import { useRuntime, useSnapshot, useTick } from '../lib/store';
import { radius, spacing, TOUCH, useTheme } from '../lib/theme';

const PRESETS = [
  { emoji: '🏋️', text: 'Beim Sport' },
  { emoji: '🏖️', text: 'Im Urlaub' },
  { emoji: '💼', text: 'Arbeite' },
  { emoji: '😴', text: 'Schlafe' },
  { emoji: '🚗', text: 'Unterwegs' },
  { emoji: '🎬', text: 'Im Kino' },
  { emoji: '🤒', text: 'Krank' },
];
const HOURS = [1, 2, 4, 8, 24];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

/** "Mein Status": a short line like "🎬 Im Kino" that my contacts see until it expires. */
export default function StatusScreen() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state } = useSnapshot();
  const now = useTick(30_000);
  const current = state.status && state.status.expiresAt > now ? state.status : undefined;
  const [emoji, setEmoji] = useState('');
  const [text, setText] = useState('');
  const [hours, setHours] = useState(2);
  const [busy, setBusy] = useState<'set' | 'clear'>();

  const cleanEmoji = emoji.trim();
  const cleanText = text.trim();
  const ready = (cleanEmoji.length > 0 || cleanText.length > 0) && !busy;

  async function apply() {
    if (!ready) return;
    setBusy('set');
    try {
      await runtime.node.setMyStatus({ emoji: cleanEmoji || undefined, text: cleanText || undefined, hours });
      close();
    } catch (e) {
      notice('Status nicht gesetzt', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function clear() {
    setBusy('clear');
    try {
      await runtime.node.setMyStatus(null);
    } catch (e) {
      notice('Das hat nicht geklappt', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Screen edges={['bottom']}>
      <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', gap: spacing.md }}>
        <Card style={{ gap: spacing.sm }}>
          <T variant="small">Gerade</T>
          {current ? (
            <>
              <Row gap={spacing.md}>
                {current.emoji ? (
                  <Text style={{ fontSize: 34 }} accessible={false}>
                    {current.emoji}
                  </Text>
                ) : null}
                <View style={{ flex: 1 }}>
                  <T variant="big">{current.text || current.emoji}</T>
                  <T variant="small">
                    bis {clockWithDay(current.expiresAt, now)} Uhr ({inTime(current.expiresAt, now)})
                  </T>
                </View>
              </Row>
              <Button title="Status löschen" kind="secondary" compact busy={busy === 'clear'} onPress={() => void clear()} />
            </>
          ) : (
            <T variant="muted">Kein Status gesetzt.</T>
          )}
        </Card>

        <Section title="Schnell wählen">
          <Wrap>
            {PRESETS.map((p) => (
              <Chip
                key={p.text}
                icon={p.emoji}
                label={p.text}
                selected={cleanEmoji === p.emoji && cleanText === p.text}
                onPress={() => {
                  setEmoji(p.emoji);
                  setText(p.text);
                }}
              />
            ))}
          </Wrap>
        </Section>

        <Section title="Oder eigener Status">
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={{ width: 96 }}>
              <Field label="Emoji" value={emoji} onChangeText={setEmoji} placeholder="🙂" maxLength={16} />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Text" value={text} onChangeText={setText} placeholder="z. B. Beim Zahnarzt" maxLength={80} counter />
            </View>
          </Row>
        </Section>

        <Section title="Wie lange?">
          <View style={{ flexDirection: 'row', gap: spacing.sm }} accessibilityRole="radiogroup">
            {HOURS.map((h) => {
              const on = hours === h;
              return (
                <Pressable
                  key={h}
                  onPress={() => setHours(h)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${h} ${h === 1 ? 'Stunde' : 'Stunden'}`}
                  style={({ pressed }) => ({
                    flex: 1,
                    minHeight: TOUCH,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: on ? t.accent : t.border,
                    backgroundColor: on ? t.accent : pressed ? t.surfaceRaised : t.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingVertical: spacing.sm,
                  })}
                >
                  <Text style={{ color: on ? t.onAccent : t.text, fontSize: 16, fontWeight: '700' }}>{h}</Text>
                  <Text style={{ color: on ? t.onAccent : t.textMuted, fontSize: 12 }}>Std.</Text>
                </Pressable>
              );
            })}
          </View>
          <T variant="small">Danach verschwindet der Status von selbst.</T>
        </Section>

        <View style={{ marginTop: spacing.lg, gap: spacing.md }}>
          {(cleanEmoji || cleanText) && (
            <Card>
              <T variant="small">So sehen es deine Kontakte:</T>
              <T variant="h2">{[cleanEmoji, cleanText].filter(Boolean).join(' ')}</T>
            </Card>
          )}
          <BigButton title={current ? 'Status ändern' : 'Status setzen'} icon="✨" onPress={() => void apply()} disabled={!ready} busy={busy === 'set'} />
          <T variant="small" style={{ textAlign: 'center' }}>
            Alle deine Kontakte sehen deinen Status.
          </T>
        </View>
      </View>
    </Screen>
  );
}
