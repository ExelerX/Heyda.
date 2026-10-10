import { router } from 'expo-router';
import { View } from 'react-native';
import { Avatar, Button, Card, Empty, Row, Screen, T } from '../../components/ui';
import { ago } from '../../lib/format';
import { useSnapshot, useTick } from '../../lib/store';
import { spacing } from '../../lib/theme';

export default function Chats() {
  const { state, chats } = useSnapshot();
  const now = useTick();
  const rows = state.contacts
    .map((c) => ({ contact: c, last: chats[c.key]?.[(chats[c.key]?.length ?? 0) - 1] }))
    .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));

  return (
    <Screen title="Chats">
      {rows.length === 0 ? (
        <Empty
          icon="💬"
          title="Noch keine Chats"
          text="Sobald du jemanden hinzugefügt hast, könnt ihr hier schreiben. Ende-zu-Ende-verschlüsselt."
          action={<Button title="Freund hinzufügen" onPress={() => router.push('/pair')} />}
        />
      ) : (
        rows.map(({ contact, last }) => (
          <Card key={contact.key} onPress={() => router.push(`/chat/${contact.key}`)} label={`Chat mit ${contact.name}`}>
            <Row gap={spacing.md}>
              <Avatar name={contact.name} keyHex={contact.key} />
              <View style={{ flex: 1, gap: 2 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T variant="h2" numberOfLines={1} style={{ flexShrink: 1 }}>
                    {contact.name}
                  </T>
                  {last && <T variant="small">{ago(last.at, now)}</T>}
                </Row>
                <T variant="muted" numberOfLines={1}>
                  {last ? `${last.from === 'me' ? 'Du: ' : ''}${last.text}` : 'Sag hallo 👋'}
                </T>
              </View>
            </Row>
          </Card>
        ))
      )}
    </Screen>
  );
}
