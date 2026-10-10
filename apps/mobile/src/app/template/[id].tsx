import { describeRule, instantiateTemplate, type SlotDef, type SlotValues } from '@fastda/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Button, Card, Chip, Hint, Screen, Section, T, Wrap } from '../../components/ui';
import { useContactName, useRuntime, useSnapshot } from '../../lib/store';
import { fillSentence } from '../../lib/templates-ui';
import { radius, spacing, useTheme } from '../../lib/theme';

const MINUTES = [2, 5, 10, 15, 30];
const PLACE_SUGGESTIONS = ['Zuhause', 'Arbeit', 'Schule', 'Supermarkt', 'Sport'];

export default function TemplateEditor() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const runtime = useRuntime();
  const { state, templates } = useSnapshot();
  const contactName = useContactName();
  const template = templates.find((x) => x.id === id);
  const [values, setValues] = useState<SlotValues>(() =>
    Object.fromEntries((template?.slots ?? []).flatMap((s) => (s.default !== undefined ? [[s.name, s.default]] : []))),
  );

  if (!template) {
    return (
      <Screen edges={['bottom']}>
        <T variant="muted">Diese Vorlage gibt es nicht mehr.</T>
      </Screen>
    );
  }

  const set = (name: string, value: string | number) => setValues((v) => ({ ...v, [name]: value }));
  const result = instantiateTemplate(template, values);
  const placeName = (pid: string) => state.places.find((p) => p.id === pid)?.name ?? '?';

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: template.title }} />
      <Card style={{ borderColor: t.accent, borderWidth: 1 }}>
        <T variant="big">{fillSentence(template, values, state)}</T>
      </Card>

      {template.slots.map((slot) => (
        <Section key={slot.name} title={slot.label}>
          <SlotInput slot={slot} value={values[slot.name]} onChange={(v) => set(slot.name, v)} />
        </Section>
      ))}

      <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
        {result.ok ? (
          <Hint>So funktioniert es: {describeRule(result.value, { contactName, placeName })}</Hint>
        ) : (
          <T variant="small">Noch offen: {result.errors.join(', ')}</T>
        )}
        <Button
          title="Automation speichern"
          icon="⚡"
          disabled={!result.ok}
          onPress={() => {
            if (!result.ok) return;
            runtime.saveRule(result.value);
            router.back();
          }}
        />
      </View>
    </Screen>
  );
}

function SlotInput({ slot, value, onChange }: { slot: SlotDef; value: string | number | undefined; onChange: (v: string | number) => void }) {
  const t = useTheme();
  const { state } = useSnapshot();
  const input = {
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: t.text,
    fontSize: 16,
    padding: spacing.md,
  } as const;

  switch (slot.kind) {
    case 'contact':
      return (
        <Wrap>
          {slot.allowAny && <Chip label="Jemand" icon="👥" selected={value === 'any'} onPress={() => onChange('any')} />}
          {state.contacts.map((c) => (
            <Chip key={c.key} label={c.name} selected={value === c.key} onPress={() => onChange(c.key)} />
          ))}
          {!state.contacts.length && <T variant="small">Füge zuerst jemanden hinzu.</T>}
        </Wrap>
      );
    case 'minutes':
      return (
        <Wrap>
          {MINUTES.map((m) => (
            <Chip key={m} label={`${m} min`} selected={value === m} onPress={() => onChange(m)} />
          ))}
        </Wrap>
      );
    case 'my_place':
      return state.places.length ? (
        <Wrap>
          {state.places.map((p) => (
            <Chip key={p.id} label={p.name} icon="📍" selected={value === p.id} onPress={() => onChange(p.id)} />
          ))}
        </Wrap>
      ) : (
        <Button title="Ersten Ort anlegen" kind="secondary" onPress={() => router.push('/places')} />
      );
    case 'place_name':
      return (
        <>
          <TextInput
            value={typeof value === 'string' ? value : ''}
            onChangeText={onChange}
            maxLength={60}
            placeholder="Name des Ortes"
            placeholderTextColor={t.textMuted}
            accessibilityLabel={slot.label}
            style={input}
          />
          <Wrap>
            {PLACE_SUGGESTIONS.map((p) => (
              <Chip key={p} label={p} selected={value === p} onPress={() => onChange(p)} />
            ))}
          </Wrap>
          <T variant="small">So, wie die andere Person den Ort genannt hat.</T>
        </>
      );
    case 'text':
      return (
        <TextInput
          value={typeof value === 'string' ? value : ''}
          onChangeText={onChange}
          maxLength={200}
          placeholderTextColor={t.textMuted}
          accessibilityLabel={slot.label}
          style={input}
        />
      );
  }
}
