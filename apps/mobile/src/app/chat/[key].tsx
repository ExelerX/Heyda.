import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Chip, Row, T } from '../../components/ui';
import { clock } from '../../lib/format';
import { setOpenChat } from '../../lib/notifications';
import type { ChatMessage } from '../../lib/runtime';
import { useRuntime, useSnapshot } from '../../lib/store';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';

export default function Chat() {
  const t = useTheme();
  const { key } = useLocalSearchParams<{ key: string }>();
  const runtime = useRuntime();
  const { state, chats } = useSnapshot();
  const [text, setText] = useState('');
  const contact = state.contacts.find((c) => c.key === key);
  const messages = [...(chats[key] ?? [])].reverse();

  useFocusEffect(
    useCallback(() => {
      setOpenChat(key);
      return () => setOpenChat(undefined);
    }, [key]),
  );

  if (!contact) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, padding: spacing.lg }}>
        <T variant="muted">Diesen Kontakt gibt es nicht mehr.</T>
      </View>
    );
  }

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    void runtime.sendChat(contact.key, value);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: contact.name,
          headerRight: () => (
            <Pressable
              onPress={() => router.push(`/contact/${contact.key}`)}
              accessibilityRole="button"
              accessibilityLabel="Kontakt-Details"
              style={{ minWidth: TOUCH, minHeight: TOUCH, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ fontSize: 20 }}>{contact.verified ? '✅' : 'ℹ️'}</Text>
            </Pressable>
          ),
        }}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <FlatList
          inverted
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
          renderItem={({ item }) => <Bubble message={item} />}
          ListFooterComponent={
            <View style={{ alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg }}>
              <T variant="small" style={{ textAlign: 'center' }}>
                🔒 Ende-zu-Ende-verschlüsselt. Nachrichten warten höchstens 7 Tage verschlüsselt auf den Relays, falls
                {` ${contact.name}`} offline ist.
              </T>
              {!contact.verified && (
                <Chip label="Sicherheitsnummer vergleichen" icon="🛡️" onPress={() => router.push(`/contact/${contact.key}`)} />
              )}
            </View>
          }
        />
        <Row style={{ paddingHorizontal: spacing.md, paddingTop: spacing.sm }}>
          <Chip label="Tragen helfen?" icon="🛍️" onPress={() => void runtime.sendPing(contact.key, 'help-carry')} />
          <Chip label="Abholen?" icon="🚗" onPress={() => void runtime.sendPing(contact.key, 'pickup-request')} />
        </Row>
        <Row style={{ padding: spacing.md }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Nachricht"
            placeholderTextColor={t.textMuted}
            maxLength={4000}
            multiline
            accessibilityLabel="Nachricht schreiben"
            style={{
              flex: 1,
              minHeight: TOUCH,
              maxHeight: 120,
              backgroundColor: t.surface,
              borderColor: t.border,
              borderWidth: 1,
              borderRadius: radius.lg,
              color: t.text,
              fontSize: 16,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.md,
            }}
          />
          <Pressable
            onPress={send}
            disabled={!text.trim()}
            accessibilityRole="button"
            accessibilityLabel="Senden"
            style={{
              width: TOUCH,
              height: TOUCH,
              borderRadius: TOUCH / 2,
              backgroundColor: t.accent,
              opacity: text.trim() ? 1 : 0.4,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: t.onAccent, fontSize: 20, fontWeight: '800' }}>↑</Text>
          </Pressable>
        </Row>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const t = useTheme();
  const mine = message.from === 'me';
  return (
    <View
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '82%',
        backgroundColor: mine ? t.accent : t.surfaceRaised,
        borderRadius: radius.lg,
        borderBottomRightRadius: mine ? 4 : radius.lg,
        borderBottomLeftRadius: mine ? radius.lg : 4,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderWidth: message.kind === 'ping' && !mine ? 1 : 0,
        borderColor: t.accent,
      }}
    >
      <Text style={{ color: mine ? t.onAccent : t.text, fontSize: 16, lineHeight: 22 }}>{message.text}</Text>
      <Text style={{ color: mine ? t.onAccent : t.textMuted, fontSize: 11, opacity: 0.75, alignSelf: 'flex-end', marginTop: 2 }}>
        {clock(message.at)}
      </Text>
    </View>
  );
}
