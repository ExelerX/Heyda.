import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ContactPicker } from '../../components/social/ContactPicker';
import { errorText } from '../../components/social/format';
import { Field, ListCard, ListRow, Narrow, NotFound } from '../../components/social/kit';
import { LIMITS } from '../../components/social/limits';
import { idParam } from '../../components/social/params';
import { Avatar, Button, Pill, Row, Screen, Section, T } from '../../components/ui';
import { confirm, notice } from '../../lib/confirm';
import { useContactName, useRuntime, useSnapshot } from '../../lib/store';
import { spacing, useTheme } from '../../lib/theme';

export default function GroupDetails() {
  const t = useTheme();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = idParam(params.id);
  const runtime = useRuntime();
  const { state } = useSnapshot();
  const contactName = useContactName();
  const group = id ? state.groups.find((g) => g.id === id && !g.dissolved) : undefined;
  const [name, setName] = useState(group?.name ?? '');
  const [adding, setAdding] = useState<string[]>([]);
  const [busy, setBusy] = useState<string>();

  // Follow renames that arrive from the owner.
  useEffect(() => {
    if (group) setName(group.name);
  }, [group?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!group) {
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: 'Gruppe' }} />
        <Narrow>
          <NotFound title="Gruppe nicht gefunden" text="Diese Gruppe gibt es nicht mehr, oder du bist nicht mehr dabei." />
        </Narrow>
      </Screen>
    );
  }

  const me = state.self.key;
  const isOwner = group.owner === me;
  const others = group.members.filter((m) => m.key !== me).map((m) => m.key);
  const candidates = state.contacts.filter((c) => !group.members.some((m) => m.key === c.key));
  const room = LIMITS.groupMembers - group.members.length;
  const members = [...group.members].sort(
    (a, b) =>
      Number(b.key === group.owner) - Number(a.key === group.owner) ||
      Number(b.key === me) - Number(a.key === me) ||
      contactName(a.key).localeCompare(contactName(b.key), 'de'),
  );

  async function run(what: string, fn: () => Promise<void>, failTitle: string) {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      notice(failTitle, errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  const rename = () => run('rename', () => runtime.node.editGroup(group.id, { name: name.trim() }), 'Nicht umbenannt');

  const remove = async (key: string) => {
    const who = contactName(key);
    if (others.length <= 1) {
      notice('Geht nicht', 'Eine Gruppe braucht mindestens eine weitere Person. Du kannst die Gruppe stattdessen auflösen.');
      return;
    }
    const ok = await confirm({
      title: `${who} entfernen?`,
      message: `${who} bekommt keine Nachrichten aus „${group.name}“ mehr.`,
      ok: 'Entfernen',
      destructive: true,
    });
    if (ok) await run(`remove-${key}`, () => runtime.node.editGroup(group.id, { members: others.filter((k) => k !== key) }), 'Nicht entfernt');
  };

  const add = () =>
    run(
      'add',
      async () => {
        await runtime.node.editGroup(group.id, { members: [...others, ...adding] });
        setAdding([]);
      },
      'Nicht hinzugefügt',
    );

  async function leave() {
    const ok = await confirm(
      isOwner
        ? {
            title: 'Gruppe auflösen?',
            message: `Du hast „${group!.name}“ erstellt. Wenn du gehst, wird die Gruppe für alle aufgelöst und der Chat verschwindet.`,
            ok: 'Auflösen',
            destructive: true,
          }
        : {
            title: 'Gruppe verlassen?',
            message: `Du bekommst keine Nachrichten aus „${group!.name}“ mehr, und der Chat verschwindet. Nur wer die Gruppe erstellt hat, kann dich wieder hinzufügen.`,
            ok: 'Verlassen',
            destructive: true,
          },
    );
    if (!ok) return;
    setBusy('leave');
    try {
      await runtime.node.leaveGroup(group!.id);
      router.dismissTo('/chats');
    } catch (e) {
      notice('Hat nicht geklappt', errorText(e));
      setBusy(undefined);
    }
  }

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: group.name }} />
      <Narrow>
        <Row gap={spacing.md}>
          <T variant="big" style={{ flex: 1 }}>
            {`👥 ${group.name}`}
          </T>
        </Row>
        <T variant="muted">
          {`${group.members.length} Personen · ${isOwner ? 'Du hast die Gruppe erstellt.' : `Erstellt von ${contactName(group.owner)}.`}`}
        </T>
        <Button
          title="Zum Chat"
          icon="💬"
          kind="secondary"
          onPress={() => router.push({ pathname: '/chat/[key]', params: { key: `g:${group.id}` } })}
        />

        {isOwner ? (
          <Section title="Name">
            <Field label="Name der Gruppe" value={name} onChangeText={setName} maxLength={LIMITS.groupName} returnKeyType="done" />
            {name.trim() !== group.name ? (
              <Button title="Namen speichern" onPress={() => void rename()} disabled={!name.trim()} busy={busy === 'rename'} />
            ) : null}
          </Section>
        ) : null}

        <Section title="Mitglieder">
          <ListCard>
            {members.map((m, i) => {
              const isMe = m.key === me;
              const label = isMe ? 'Du' : contactName(m.key);
              const contact = state.contacts.some((c) => c.key === m.key);
              return (
                <ListRow
                  key={m.key}
                  first={i === 0}
                  onPress={contact ? () => router.push({ pathname: '/contact/[key]', params: { key: m.key } }) : undefined}
                  label={`${label}${m.key === group.owner ? ', hat die Gruppe erstellt' : ''}`}
                >
                  <Row gap={spacing.md}>
                    <Avatar name={isMe ? state.self.name : label} keyHex={m.key} size={36} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <T numberOfLines={1}>{label}</T>
                      {!isMe && !contact ? <T variant="small">Nicht in deinen Kontakten</T> : null}
                    </View>
                    {m.key === group.owner ? <Pill text="Ersteller" color={t.accent} /> : null}
                    {isOwner && !isMe ? (
                      <Button
                        title="Entfernen"
                        kind="ghost"
                        compact
                        onPress={() => void remove(m.key)}
                        busy={busy === `remove-${m.key}`}
                      />
                    ) : null}
                  </Row>
                </ListRow>
              );
            })}
          </ListCard>
          {!isOwner ? <T variant="small">Nur wer die Gruppe erstellt hat, kann Leute hinzufügen oder entfernen.</T> : null}
        </Section>

        {isOwner ? (
          <Section title="Leute hinzufügen">
            {room <= 0 ? (
              <T variant="muted">{`Die Gruppe ist voll (höchstens ${LIMITS.groupMembers} Personen).`}</T>
            ) : candidates.length === 0 ? (
              <T variant="muted">Alle deine Kontakte sind schon dabei.</T>
            ) : (
              <>
                <ContactPicker contacts={candidates} selected={adding} onChange={setAdding} max={room} />
                <Button
                  title={adding.length ? `${adding.length} hinzufügen` : 'Hinzufügen'}
                  icon="➕"
                  onPress={() => void add()}
                  disabled={!adding.length}
                  busy={busy === 'add'}
                />
              </>
            )}
          </Section>
        ) : null}

        <Section title={isOwner ? 'Gruppe auflösen' : 'Gruppe verlassen'}>
          <T variant="small">
            {isOwner
              ? 'Wenn du als Ersteller gehst, wird die Gruppe für alle aufgelöst.'
              : 'Wer die Gruppe erstellt hat, bekommt Bescheid.'}
          </T>
          <Button
            title={isOwner ? 'Gruppe auflösen' : 'Gruppe verlassen'}
            kind="danger"
            onPress={() => void leave()}
            busy={busy === 'leave'}
          />
        </Section>
      </Narrow>
    </Screen>
  );
}
