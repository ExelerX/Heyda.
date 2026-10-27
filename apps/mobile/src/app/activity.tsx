import type { Alert } from '@heyda/core';
import { router, Stack } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityRow } from '../components/social/ActivityRow';
import { dayLabel, sameDay } from '../components/social/format';
import { Button, Empty, T } from '../components/ui';
import { confirm } from '../lib/confirm';
import { routeForAlert } from '../lib/routes';
import { useRuntime, useSnapshot } from '../lib/store';
import { useNow } from '../components/social/useNow';
import { radius, spacing, useTheme } from '../lib/theme';

type Item = { type: 'day'; id: string; label: string } | { type: 'alert'; id: string; alert: Alert; first: boolean; last: boolean };

export default function Activity() {
  const t = useTheme();
  const runtime = useRuntime();
  const { activity, state } = useSnapshot();
  const now = useNow(30_000);

  const items = useMemo(() => {
    const out: Item[] = [];
    const sorted = [...activity].sort((a, b) => b.at - a.at);
    sorted.forEach((a, i) => {
      const prev = sorted[i - 1];
      const next = sorted[i + 1];
      const newDay = !prev || !sameDay(prev.at, a.at);
      if (newDay) out.push({ type: 'day', id: `day-${a.id}`, label: dayLabel(a.at, now) });
      out.push({ type: 'alert', id: a.id, alert: a, first: newDay, last: !next || !sameDay(next.at, a.at) });
    });
    return out;
  }, [activity, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps

  async function clear() {
    const ok = await confirm({
      title: 'Alles löschen?',
      message: 'Die Aktivitätsliste wird auf diesem Gerät geleert. Chats bleiben erhalten.',
      ok: 'Alles löschen',
      destructive: true,
    });
    if (ok) runtime.clearActivity();
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: 'Aktivität',
          headerRight: activity.length ? () => <Button title="Alles löschen" kind="ghost" compact onPress={() => void clear()} /> : undefined,
        }}
      />
      {items.length === 0 ? (
        <View style={{ padding: spacing.lg, width: '100%', maxWidth: 720, alignSelf: 'center' }}>
          <Empty
            icon="🔔"
            title="Noch nichts passiert"
            text="Hier landen Ankünfte, Nachrichten, Fragen und Hinweise deiner Freunde – auch die, für die es keine Benachrichtigung gab."
          />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          style={{ width: '100%', maxWidth: 720, alignSelf: 'center' }}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl * 2 }}
          renderItem={({ item }) =>
            item.type === 'day' ? (
              <T variant="h2" style={{ marginTop: spacing.lg, marginBottom: spacing.sm }}>
                {item.label}
              </T>
            ) : (
              <View
                style={{
                  backgroundColor: t.surface,
                  borderColor: t.border,
                  borderLeftWidth: 1,
                  borderRightWidth: 1,
                  borderTopWidth: item.first ? 1 : 0,
                  borderBottomWidth: item.last ? 1 : 0,
                  borderTopLeftRadius: item.first ? radius.md : 0,
                  borderTopRightRadius: item.first ? radius.md : 0,
                  borderBottomLeftRadius: item.last ? radius.md : 0,
                  borderBottomRightRadius: item.last ? radius.md : 0,
                  overflow: 'hidden',
                }}
              >
                <ActivityRow alert={item.alert} now={now} first={item.first} onPress={() => router.push(routeForAlert(item.alert, state.self.key))} />
              </View>
            )
          }
          ListFooterComponent={
            <T variant="small" style={{ textAlign: 'center', marginTop: spacing.lg }}>
              Die letzten 300 Einträge, nur auf diesem Gerät.
            </T>
          }
        />
      )}
    </SafeAreaView>
  );
}
