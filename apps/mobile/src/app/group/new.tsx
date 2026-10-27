import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ContactPicker } from '../../components/social/ContactPicker';
import { errorText } from '../../components/social/format';
import { Field, Narrow } from '../../components/social/kit';
import { LIMITS } from '../../components/social/limits';
import { Button, Empty, Hint, Screen, Section, T } from '../../components/ui';
import { notice } from '../../lib/confirm';
import { useRuntime, useSnapshot } from '../../lib/store';
import { spacing } from '../../lib/theme';

/** Others besides me. */
const MAX_OTHERS = LIMITS.groupMembers - 1;

export default function NewGroup() {
  const runtime = useRuntime();
  const { state } = useSnapshot();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const clean = name.trim();
  const ready = clean.length > 0 && members.length > 0 && !busy;

  async function create() {
    if (!ready) return;
    setBusy(true);
    try {
      const group = await runtime.node.createGroup(clean, members);
      router.replace({ pathname: '/chat/[key]', params: { key: `g:${group.id}` } });
    } catch (e) {
      notice('Gruppe nicht erstellt', errorText(e));
      setBusy(false);
    }
  }

  if (!state.contacts.length) {
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: 'Neue Gruppe' }} />
        <Narrow>
          <Empty
            icon="👥"
            title="Erst Freunde hinzufügen"
            text="In eine Gruppe kannst du Leute aus deinen Kontakten holen. Füge zuerst jemanden hinzu."
            action={<Button title="Freund hinzufügen" icon="🤝" onPress={() => router.replace('/pair')} />}
          />
        </Narrow>
      </Screen>
    );
  }

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Neue Gruppe' }} />
      <Narrow>
        <Field
          label="Name der Gruppe"
          value={name}
          onChangeText={setName}
          maxLength={LIMITS.groupName}
          placeholder="z. B. Familie"
          autoFocus
          returnKeyType="done"
        />

        <Section title="Wer ist dabei?">
          <ContactPicker contacts={state.contacts} selected={members} onChange={setMembers} max={MAX_OTHERS} />
          <Hint>
            {`Alle in der Gruppe sehen die Namen der anderen und können schreiben. Nur du kannst später Leute hinzufügen oder entfernen. Höchstens ${LIMITS.groupMembers} Personen mit dir.`}
          </Hint>
        </Section>

        <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
          <Button title="Gruppe erstellen" icon="👥" onPress={() => void create()} disabled={!ready} busy={busy} />
          {!clean || !members.length ? (
            <T variant="small" style={{ textAlign: 'center' }}>
              {!clean ? 'Gib der Gruppe einen Namen.' : 'Wähle mindestens eine Person aus.'}
            </T>
          ) : (
            <T variant="small" style={{ textAlign: 'center' }}>
              {`${members.length + 1} Personen mit dir`}
            </T>
          )}
        </View>
      </Narrow>
    </Screen>
  );
}
