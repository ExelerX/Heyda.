import { describeRule, type RuleTemplate } from '@fastda/core';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Card, Empty, Hint, Pill, Row, Screen, Section, T, Toggle } from '../../components/ui';
import { useContactName, useRuntime, useSnapshot } from '../../lib/store';
import { CATEGORY_TEXT, matchesSearch, TIPS } from '../../lib/templates-ui';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';

export default function Automations() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, templates } = useSnapshot();
  const contactName = useContactName();
  const [query, setQuery] = useState('');
  const tip = useMemo(() => TIPS[new Date().getDate() % TIPS.length]!, []);

  const placeName = (id: string) => state.places.find((p) => p.id === id)?.name ?? 'einem Ort';
  const found = templates.filter((tpl) => matchesSearch(tpl, query));
  const groups = Object.entries(CATEGORY_TEXT)
    .map(([cat, label]) => ({ label, items: found.filter((tpl) => tpl.category === cat) }))
    .filter((g) => g.items.length);

  return (
    <Screen title="Automationen">
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="🔎  Was soll passieren? z. B. „tragen“"
        placeholderTextColor={t.textMuted}
        accessibilityLabel="Vorlagen durchsuchen"
        style={{
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: radius.md,
          color: t.text,
          fontSize: 16,
          padding: spacing.md,
          minHeight: TOUCH,
        }}
      />

      {!query && (
        <Section title="Meine Automationen">
          {state.rules.length === 0 ? (
            <Empty icon="⚡" title="Noch keine" text="Wähle unten eine Vorlage. Du füllst nur die Lücken aus, ganz ohne Code." />
          ) : (
            state.rules.map((rule) => (
              <Card key={rule.id}>
                <Toggle
                  label={rule.name}
                  detail={describeRule(rule, { contactName, placeName })}
                  value={rule.enabled}
                  onChange={(v) => runtime.toggleRule(rule.id, v)}
                />
                <Row style={{ justifyContent: 'flex-end' }}>
                  <Pressable
                    onPress={() => runtime.removeRule(rule.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`${rule.name} löschen`}
                    style={{ minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: spacing.sm }}
                  >
                    <Text style={{ color: t.danger, fontWeight: '600' }}>Löschen</Text>
                  </Pressable>
                </Row>
              </Card>
            ))
          )}
        </Section>
      )}

      {groups.map((g) => (
        <Section key={g.label} title={g.label}>
          {g.items.map((tpl) => (
            <TemplateCard key={tpl.id} template={tpl} />
          ))}
        </Section>
      ))}
      {query && !found.length && <T variant="muted">Keine passende Vorlage. Versuch ein anderes Wort, z. B. „ankommen“.</T>}

      {!query && (
        <Section title="Mehr">
          <Hint>{tip}</Hint>
          <Card onPress={() => router.push('/plugin')} label="Plugin importieren">
            <T variant="h2">📦 Plugin importieren</T>
            <T variant="muted">Vorlagen-Pakete von Freunden. Sie enthalten keinen Code.</T>
          </Card>
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="h2">🧩 Puzzle-Editor</T>
              <Pill text="bald" color={t.textMuted} />
            </Row>
            <T variant="muted">Eigene Regeln aus Bausteinen zusammenstecken.</T>
          </Card>
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="h2">✨ Regel aus einem Satz</T>
              <Pill text="bald" color={t.textMuted} />
            </Row>
            <T variant="muted">Schreib, was passieren soll. Du bestätigst jede Regel, bevor sie aktiv wird.</T>
          </Card>
        </Section>
      )}
    </Screen>
  );
}

function TemplateCard({ template }: { template: RuleTemplate }) {
  const t = useTheme();
  const sentence = template.sentence.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, n: string) => {
    const slot = template.slots.find((s) => s.name === n);
    return `[${slot?.label ?? n}]`;
  });
  return (
    <Card onPress={() => router.push(`/template/${encodeURIComponent(template.id)}`)} label={template.title}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="h2">{template.title}</T>
        {!template.id.startsWith('core.') && <Pill text="Plugin" color={t.info} />}
      </Row>
      <View>
        <T variant="muted">{sentence}</T>
      </View>
    </Card>
  );
}
