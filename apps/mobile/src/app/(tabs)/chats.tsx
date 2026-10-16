import { contactLabel, type ChatEntry } from '@heyda/core';
import { router } from 'expo-router';
import { View } from 'react-native';
import { listTime } from '../../components/social/format';
import { CountBadge, ListCard, ListRow, Narrow } from '../../components/social/kit';
import { ThreadAvatar } from '../../components/social/ThreadAvatar';
import { Button, Empty, Row, Screen, T } from '../../components/ui';
import { useContactName, useSnapshot } from '../../lib/store';
import { useNow } from '../../components/social/useNow';
import { spacing, useTheme } from '../../lib/theme';

interface ThreadRow {
  thread: string;
  name: string;
  last?: ChatEntry;
  muted?: boolean;
  group: boolean;
  favorite?: boolean;
  members?: number;
}

export default function Chats() {
  const t = useTheme();
  const { state, chats, unread } = useSnapshot();
  const contactName = useContactName();
  const now = useNow(60_000);

  const rows: ThreadRow[] = [
    ...state.contacts.map((c): ThreadRow => ({
      thread: c.key,
      name: contactLabel(c),
      last: chats[c.key]?.at(-1),
      muted: c.muted,
      favorite: c.favorite,
      group: false,
    })),
    ...state.groups
      .filter((g) => !g.dissolved)
      .map((g): ThreadRow => ({ thread: `g:${g.id}`, name: g.name, last: chats[`g:${g.id}`]?.at(-1), group: true, members: g.members.length })),
  ].sort(
    (a, b) =>
      (b.last?.at ?? 0) - (a.last?.at ?? 0) ||
      Number(!!b.favorite) - Number(!!a.favorite) ||
      a.name.localeCompare(b.name, 'de'),
  );

  const preview = (r: ThreadRow): string => {
    if (!r.last) return r.group ? `Gruppe mit ${r.members ?? 0} Personen · Schreib die erste Nachricht` : 'Noch keine Nachrichten · Sag hallo 👋';
    const who = r.last.from === 'me' ? 'Du: ' : r.group ? `${contactName(r.last.from)}: ` : '';
    return `${r.last.urgent ? '❗ ' : ''}${who}${r.last.text}`;
  };

  return (
    <Screen
      title="Chats"
      right={state.contacts.length ? <Button title="Neue Gruppe" icon="👥" kind="ghost" compact onPress={() => router.push('/group/new')} /> : undefined}
    >
      <Narrow>
        {rows.length === 0 ? (
          <Empty
            icon="💬"
            title="Noch keine Chats"
            text="Sobald du jemanden hinzugefügt hast, könnt ihr hier schreiben – Ende-zu-Ende-verschlüsselt."
            action={<Button title="Freund hinzufügen" icon="🤝" onPress={() => router.push('/pair')} />}
          />
        ) : (
          <ListCard>
            {rows.map((r, i) => {
              const count = unread[r.thread] ?? 0;
              const text = preview(r);
              return (
                <ListRow
                  key={r.thread}
                  first={i === 0}
                  onPress={() => router.push({ pathname: '/chat/[key]', params: { key: r.thread } })}
                  label={[
                    r.group ? `Gruppe ${r.name}` : `Chat mit ${r.name}`,
                    count ? `${count} ungelesen` : undefined,
                    r.muted ? 'stumm' : undefined,
                    text,
                  ]
                    .filter(Boolean)
                    .join('. ')}
                >
                  <Row gap={spacing.md}>
                    <ThreadAvatar thread={r.thread} name={r.name} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Row style={{ justifyContent: 'space-between' }} gap={spacing.sm}>
                        <T variant="h2" numberOfLines={1} style={{ flexShrink: 1 }}>
                          {`${r.name}${r.muted ? ' 🔕' : ''}`}
                        </T>
                        {r.last ? (
                          <T variant="small" color={count ? t.accent : undefined}>
                            {listTime(r.last.at, now)}
                          </T>
                        ) : null}
                      </Row>
                      <Row gap={spacing.sm}>
                        <T variant="muted" numberOfLines={1} style={{ flex: 1 }} color={count ? t.text : undefined}>
                          {text}
                        </T>
                        <CountBadge count={count} />
                      </Row>
                    </View>
                  </Row>
                </ListRow>
              );
            })}
          </ListCard>
        )}
        {rows.length > 0 && state.groups.length === 0 ? (
          <T variant="small" style={{ textAlign: 'center', marginTop: spacing.sm }}>
            Tipp: Mit „Neue Gruppe“ schreibt ihr zu mehreren, z. B. als Familie.
          </T>
        ) : null}
      </Narrow>
    </Screen>
  );
}
