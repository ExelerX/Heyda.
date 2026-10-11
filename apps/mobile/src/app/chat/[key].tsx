import { contactLabel, PING_LABELS, PING_KINDS, type ChatEntry, type PingKind } from '@heyda/core';
import { router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { quietText } from '../../components/social/describe';
import { ago, dayLabel, errorText, hhmm, sameDay } from '../../components/social/format';
import { Banner, HeaderButton, NotFound } from '../../components/social/kit';
import { LIMITS } from '../../components/social/limits';
import { threadParam } from '../../components/social/params';
import { Chip, Row, T } from '../../components/ui';
import { notice } from '../../lib/confirm';
import { setOpenThread as setNotificationThread } from '../../lib/notifications';
import { useContactName, useRuntime, useSnapshot, useTick } from '../../lib/store';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';

type Item = { type: 'day'; id: string; label: string } | { type: 'msg'; id: string; entry: ChatEntry; showName: boolean };

const DAY = 24 * 3600_000;
const PINGS: PingKind[] = PING_KINDS.filter((k) => k !== 'custom');

export default function ChatScreen() {
  const t = useTheme();
  const params = useLocalSearchParams<{ key?: string | string[] }>();
  const thread = threadParam(params.key);
  const runtime = useRuntime();
  const { state, chats, statuses } = useSnapshot();
  const contactName = useContactName();
  const now = useTick(30_000);
  const focused = useIsFocused();
  const listRef = useRef<FlatList<Item>>(null);
  const [text, setText] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  const contact = thread?.kind === 'contact' ? state.contacts.find((c) => c.key === thread.key) : undefined;
  const group = thread?.kind === 'group' ? state.groups.find((g) => g.id === thread.id && !g.dissolved) : undefined;
  const threadId = contact ? contact.key : group ? `g:${group.id}` : undefined;
  const entries = useMemo(() => (threadId ? chats[threadId] ?? [] : []), [chats, threadId]);

  // The open chat counts as read and gets no banners.
  useFocusEffect(
    useCallback(() => {
      if (!threadId) return undefined;
      runtime.setOpenThread(threadId);
      setNotificationThread(threadId);
      return () => {
        runtime.setOpenThread(undefined);
        setNotificationThread(undefined);
      };
    }, [runtime, threadId]),
  );
  useEffect(() => {
    if (focused && threadId) runtime.markRead(threadId);
  }, [focused, threadId, entries.length, runtime]);

  const items = useMemo(() => {
    const out: Item[] = [];
    let prev: ChatEntry | undefined;
    for (const e of entries) {
      const newDay = !prev || !sameDay(prev.at, e.at);
      if (newDay) out.push({ type: 'day', id: `day-${e.id}`, label: dayLabel(e.at) });
      const showName = !!group && e.from !== 'me' && e.kind !== 'system' && (newDay || prev?.from !== e.from);
      out.push({ type: 'msg', id: e.id, entry: e, showName });
      prev = e;
    }
    return out.reverse();
    // dayLabel depends on the current day too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, group, Math.floor(now / DAY)]);

  if (!thread || (!contact && !group)) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg, padding: spacing.lg }} edges={['bottom']}>
        <Stack.Screen options={{ title: 'Chat' }} />
        <NotFound
          title={thread?.kind === 'group' ? 'Gruppe nicht gefunden' : 'Chat nicht gefunden'}
          text={
            thread?.kind === 'group'
              ? 'Diese Gruppe gibt es nicht mehr, oder du bist nicht mehr dabei.'
              : 'Diese Person ist nicht (mehr) in deinen Kontakten.'
          }
        />
      </SafeAreaView>
    );
  }

  const name = contact ? contactLabel(contact) : group!.name;
  const status = contact ? statuses[contact.key] : undefined;
  const question = contact ? [...state.whereInbox].reverse().find((w) => w.from === contact.key) : undefined;
  const asked = contact ? [...state.whereAsked].reverse().find((w) => w.from === contact.key && now - w.at < DAY) : undefined;
  const theirQuiet = quietText(status?.presence?.dnd, now);
  const clean = text.trim();

  async function send() {
    if (!clean || busy) return;
    setBusy(true);
    try {
      if (contact) await runtime.node.sendChat(contact.key, clean, { urgent });
      else if (group) await runtime.node.sendGroupText(group.id, clean, { urgent });
      setText('');
      setUrgent(false);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      notice('Nicht gesendet', errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function ping(kind: PingKind) {
    if (!contact) return;
    try {
      await runtime.node.sendPing(contact.key, kind, undefined, { urgent });
      setUrgent(false);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      notice('Nicht gesendet', errorText(e));
    }
  }

  async function askWhere() {
    if (!contact || asking) return;
    setAsking(true);
    try {
      await runtime.node.askWhere(contact.key);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      notice('Gerade nicht möglich', errorText(e));
    } finally {
      setAsking(false);
    }
  }

  const detailsHref = contact
    ? ({ pathname: '/contact/[key]', params: { key: contact.key } } as const)
    : ({ pathname: '/group/[id]', params: { id: group!.id } } as const);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: name,
          headerRight: () => (
            <HeaderButton
              icon={group ? '👥' : contact?.verified ? '✅' : 'ℹ️'}
              label={group ? 'Gruppe: Mitglieder und Einstellungen' : `Kontakt ${name}: Details`}
              onPress={() => router.push(detailsHref)}
            />
          ),
        }}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        {question ? (
          <View style={{ padding: spacing.md, paddingBottom: 0, width: '100%', maxWidth: 720, alignSelf: 'center' }}>
            <Banner
              icon="📍"
              color={t.accent}
              title={`${name} fragt: Wo bist du?`}
              text={`${ago(question.at, now)} · Du entscheidest, was du teilst.`}
              action="Antworten"
              onPress={() => router.push({ pathname: '/where/[key]', params: { key: contact!.key, request: question.requestId } })}
            />
          </View>
        ) : null}

        {items.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md }}>
            <Text style={{ fontSize: 40 }} accessible={false}>
              {group ? '👥' : '👋'}
            </Text>
            <T variant="h2" style={{ textAlign: 'center' }}>
              {group ? `Willkommen in „${name}“` : `Schreib ${name} die erste Nachricht`}
            </T>
            <T variant="small" style={{ textAlign: 'center', maxWidth: 420 }}>
              🔒 Ende-zu-Ende-verschlüsselt. Ist jemand offline, wartet die Nachricht bis zu 7 Tage verschlüsselt und kommt dann an.
            </T>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            inverted
            data={items}
            keyExtractor={(i) => i.id}
            style={{ width: '100%', maxWidth: 720, alignSelf: 'center' }}
            contentContainerStyle={{ padding: spacing.md, gap: spacing.xs }}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) =>
              item.type === 'day' ? (
                <DaySeparator label={item.label} />
              ) : (
                <Bubble entry={item.entry} senderName={item.showName ? contactName(item.entry.from) : undefined} isGroup={!!group} name={contactName} />
              )
            }
            ListFooterComponent={
              <T variant="small" style={{ textAlign: 'center', marginBottom: spacing.md }}>
                🔒 Ende-zu-Ende-verschlüsselt
              </T>
            }
          />
        )}

        <View style={{ borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.surface }}>
          <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', gap: spacing.xs, paddingTop: spacing.sm }}>
            {contact ? (
              <>
                {asked ? (
                  <T variant="small" style={{ paddingHorizontal: spacing.md }}>
                    {`📍 Du hast ${ago(asked.at, now)} gefragt, wo ${name} ist. Die Antwort kommt hier an.`}
                  </T>
                ) : null}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: spacing.md }}
                >
                  <Chip label="Wo bist du?" icon="📍" onPress={() => void askWhere()} />
                  {PINGS.map((k) => (
                    <Chip key={k} label={PING_LABELS[k].text} icon={PING_LABELS[k].emoji} onPress={() => void ping(k)} />
                  ))}
                </ScrollView>
              </>
            ) : null}
            {urgent ? (
              <T variant="small" color={t.danger} style={{ paddingHorizontal: spacing.md }}>
                {group
                  ? '❗ Dringend: Klingelt auch bei „Bitte nicht stören“ – bei allen, die das erlauben. Nur ein paar pro Stunde.'
                  : `❗ Dringend: Klingelt auch bei „Bitte nicht stören“, wenn ${name} das erlaubt. Nur ein paar pro Stunde.`}
              </T>
            ) : theirQuiet ? (
              <T variant="small" color={t.info} style={{ paddingHorizontal: spacing.md }}>
                {`🌙 ${name}: ${theirQuiet}. Wenn es eilt, markiere die Nachricht als dringend.`}
              </T>
            ) : null}
            <Row style={{ padding: spacing.md, paddingTop: spacing.xs, alignItems: 'flex-end' }}>
              <Pressable
                onPress={() => setUrgent((u) => !u)}
                accessibilityRole="switch"
                accessibilityLabel="Dringend"
                accessibilityHint="Klingelt auch bei Bitte nicht stören, wenn die Person das erlaubt"
                accessibilityState={{ checked: urgent }}
                style={{
                  width: TOUCH,
                  height: TOUCH,
                  borderRadius: TOUCH / 2,
                  borderWidth: 1.5,
                  borderColor: urgent ? t.danger : t.border,
                  backgroundColor: urgent ? t.danger : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 18, fontWeight: '900', color: urgent ? t.bg : t.textMuted }}>!</Text>
              </Pressable>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={group ? `Nachricht an ${name}` : 'Nachricht'}
                placeholderTextColor={t.textMuted}
                maxLength={LIMITS.chat}
                multiline
                accessibilityLabel="Nachricht schreiben"
                onKeyPress={(e) => {
                  // Desktop and web: Enter sends, Shift+Enter makes a new line.
                  const ev = e as unknown as { nativeEvent: { key: string; shiftKey?: boolean }; preventDefault?: () => void };
                  if (Platform.OS === 'web' && ev.nativeEvent.key === 'Enter' && !ev.nativeEvent.shiftKey) {
                    ev.preventDefault?.();
                    void send();
                  }
                }}
                style={{
                  flex: 1,
                  minHeight: TOUCH,
                  maxHeight: 140,
                  backgroundColor: t.bg,
                  borderColor: urgent ? t.danger : t.border,
                  borderWidth: 1,
                  borderRadius: radius.lg,
                  color: t.text,
                  fontSize: 16,
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.sm + 2,
                }}
              />
              <Pressable
                onPress={() => void send()}
                disabled={!clean || busy}
                accessibilityRole="button"
                accessibilityLabel={urgent ? 'Dringend senden' : 'Senden'}
                accessibilityState={{ disabled: !clean || busy, busy }}
                style={{
                  width: TOUCH,
                  height: TOUCH,
                  borderRadius: TOUCH / 2,
                  backgroundColor: urgent ? t.danger : t.accent,
                  opacity: clean && !busy ? 1 : 0.4,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: urgent ? t.bg : t.onAccent, fontSize: 20, fontWeight: '800' }}>↑</Text>
              </Pressable>
            </Row>
            {text.length > LIMITS.chat * 0.9 ? (
              <T variant="small" style={{ textAlign: 'right', paddingHorizontal: spacing.md, paddingBottom: spacing.xs }}>
                {`${text.length}/${LIMITS.chat}`}
              </T>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function DaySeparator({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', marginVertical: spacing.sm }} accessibilityRole="header">
      <Text style={{ color: t.textMuted, fontSize: 12, fontWeight: '700', backgroundColor: t.surfaceRaised, paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden' }}>
        {label}
      </Text>
    </View>
  );
}

function Bubble({
  entry,
  senderName,
  isGroup,
  name,
}: {
  entry: ChatEntry;
  senderName?: string;
  isGroup: boolean;
  name: (key: string) => string;
}) {
  const t = useTheme();
  if (entry.kind === 'system') {
    return (
      <View style={{ alignItems: 'center', marginVertical: spacing.xs }} accessible accessibilityLabel={`${entry.text}, ${hhmm(entry.at)}`}>
        <T variant="small" style={{ textAlign: 'center' }}>
          {entry.text}
        </T>
      </View>
    );
  }
  const mine = entry.from === 'me';
  const ping = entry.kind === 'ping';
  const bg = ping ? t.surface : mine ? t.accent : t.surfaceRaised;
  const fg = ping ? t.text : mine ? t.onAccent : t.text;
  const who = mine ? 'Du' : isGroup ? name(entry.from) : name(entry.from);
  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginTop: senderName ? spacing.sm : 0 }}>
      {senderName ? (
        <T variant="small" color={t.accent} style={{ marginLeft: spacing.sm, marginBottom: 2, fontWeight: '700' }}>
          {senderName}
        </T>
      ) : null}
      <View
        accessible
        accessibilityLabel={`${who}, ${hhmm(entry.at)}${entry.urgent ? ', dringend' : ''}: ${entry.text}`}
        style={{
          maxWidth: '84%',
          backgroundColor: bg,
          borderRadius: radius.lg,
          borderBottomRightRadius: mine ? 4 : radius.lg,
          borderBottomLeftRadius: mine ? radius.lg : 4,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          borderWidth: ping || entry.urgent ? 1.5 : 0,
          borderColor: entry.urgent ? t.danger : t.accent,
        }}
      >
        {entry.urgent ? (
          <Text style={{ color: mine && !ping ? t.onAccent : t.danger, fontSize: 12, fontWeight: '800', marginBottom: 2 }}>❗ Dringend</Text>
        ) : null}
        <Text selectable style={{ color: fg, fontSize: 16, lineHeight: 22 }}>
          {entry.text}
        </Text>
        <Text style={{ color: fg, fontSize: 11, opacity: 0.7, alignSelf: 'flex-end', marginTop: 2 }}>{hhmm(entry.at)}</Text>
      </View>
    </View>
  );
}
