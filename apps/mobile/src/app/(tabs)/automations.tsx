import type { Plugin, Rule, RuleTemplate } from '@heyda/core';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { LIMITS_TEXT } from '../../components/automation/catalog';
import { RuleCard, SmallAction, TemplateCard } from '../../components/automation/cards';
import { Banner, Field, Narrow } from '../../components/setup/kit';
import { Button, Card, Chip, Empty, Hint, Row, Screen, Section, T } from '../../components/ui';
import { confirm } from '../../lib/confirm';
import { useRuntime, useSnapshot } from '../../lib/store';
import { CATEGORY_ICON, CATEGORY_TEXT, groupTemplates, TIPS } from '../../lib/templates-ui';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';

export default function Automations() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, templates, plugins, automationsActHere } = useSnapshot();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<RuleTemplate['category']>();
  const [tipIndex, setTipIndex] = useState(() => new Date().getDate() % TIPS.length);

  const groups = useMemo(() => groupTemplates(templates, query, category), [templates, query, category]);
  const categories = useMemo(
    () => (Object.keys(CATEGORY_TEXT) as RuleTemplate['category'][]).filter((c) => templates.some((x) => x.category === c)),
    [templates],
  );
  const pluginOf = (tpl: RuleTemplate) => plugins.find((p) => p.templates.some((x) => x.id === tpl.id))?.name;
  const rules = [...state.rules].sort((a, b) => Number(b.enabled) - Number(a.enabled));

  async function deleteRule(rule: Rule) {
    const ok = await confirm({ title: `„${rule.name}“ löschen?`, message: 'Die Automation ist dann weg. Du kannst sie jederzeit neu einrichten.', ok: 'Löschen', destructive: true });
    if (ok) runtime.removeRule(rule.id);
  }

  async function removePlugin(p: Plugin) {
    const ok = await confirm({
      title: `Plugin „${p.name}“ entfernen?`,
      message: 'Seine Vorlagen verschwinden. Automationen, die du schon daraus eingerichtet hast, laufen weiter.',
      ok: 'Entfernen',
      destructive: true,
    });
    if (ok) runtime.removePlugin(p.id);
  }

  return (
    <Screen title="Automationen">
      <Narrow>
        <T variant="muted">Kleine Helfer, die von selbst etwas tun. Sie laufen nur auf deinem Gerät und tun nur, was der Satz sagt.</T>

        {!automationsActHere && (
          <Banner tone="info" icon="💻" title="Dein Handy übernimmt">
            <T variant="small" color={t.text}>
              Hier zeigen Automationen nur Hinweise an. Was an andere geht, schickt dein Handy, damit nichts doppelt ankommt.
            </T>
          </Banner>
        )}

        {!state.contacts.length && (
          <Banner tone="info" icon="👋" title="Noch keine Freunde">
            <T variant="small" color={t.text}>
              Die meisten Automationen reagieren auf Freunde oder schreiben ihnen. Füge zuerst jemanden hinzu.
            </T>
            <Button title="Freund hinzufügen" kind="ghost" compact onPress={() => router.push('/pair')} style={{ alignSelf: 'flex-start' }} />
          </Banner>
        )}

        <Section title={rules.length ? `Meine Automationen (${rules.length})` : 'Meine Automationen'}>
          {rules.length === 0 ? (
            <Empty icon="⚡" title="Noch keine Automationen" text="Wähle unten eine Vorlage. Du füllst nur die Lücken aus, ganz ohne Code." />
          ) : (
            rules.map((rule) => (
              <RuleCard key={rule.id} rule={rule} onToggle={(on) => runtime.toggleRule(rule.id, on)} onDelete={() => void deleteRule(rule)} />
            ))
          )}
        </Section>

        <Pressable
          onPress={() => router.push('/rule/new')}
          accessibilityRole="button"
          accessibilityLabel="Eigene Automation bauen"
          style={({ pressed }) => ({
            marginTop: spacing.md,
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.md,
            padding: spacing.lg,
            borderRadius: radius.md,
            borderWidth: 2,
            borderStyle: 'dashed',
            borderColor: t.accent,
            backgroundColor: pressed ? t.surfaceRaised : t.surface,
          })}
        >
          <Text style={{ fontSize: 30 }} accessible={false}>
            🧩
          </Text>
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="h2">Eigene Automation bauen</T>
            <T variant="small">Wenn … und nur wenn … dann … – aus Bausteinen zusammenstecken.</T>
          </View>
          <Text style={{ color: t.accent, fontSize: 24 }} accessible={false}>
            ›
          </Text>
        </Pressable>

        <Section title="Vorlagen">
          <Field value={query} onChangeText={setQuery} placeholder="🔎  Suchen, z. B. „tragen“ oder „zuhause“" maxLength={60} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, paddingVertical: 2 }}>
            <Chip label="Alle" selected={!category} onPress={() => setCategory(undefined)} />
            {categories.map((c) => (
              <Chip key={c} icon={CATEGORY_ICON[c]} label={CATEGORY_TEXT[c]} selected={category === c} onPress={() => setCategory(category === c ? undefined : c)} />
            ))}
          </ScrollView>
          {groups.map((g) => (
            <View key={g.category} style={{ gap: spacing.sm, marginTop: spacing.sm }}>
              <T variant="small" style={{ fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {`${CATEGORY_ICON[g.category]} ${g.label}`}
              </T>
              {g.items.map((tpl) => (
                <TemplateCard key={tpl.id} template={tpl} pluginName={pluginOf(tpl)} />
              ))}
            </View>
          ))}
          {!groups.length && (
            <Card>
              <T variant="muted">Keine passende Vorlage. Versuch ein anderes Wort, z. B. „ankommen“, oder bau dir eine eigene Automation.</T>
              <Button
                title="Suche zurücksetzen"
                kind="ghost"
                compact
                onPress={() => {
                  setQuery('');
                  setCategory(undefined);
                }}
              />
            </Card>
          )}
        </Section>

        <Section title="Plugins" action={<SmallAction label="Importieren" color={t.accent} onPress={() => router.push('/plugin')} />}>
          {plugins.length === 0 ? (
            <Card onPress={() => router.push('/plugin')} label="Plugin importieren">
              <Row>
                <Text style={{ fontSize: 22 }} accessible={false}>
                  📦
                </Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="h2">Plugin importieren</T>
                  <T variant="small">Vorlagen-Pakete von Freunden. Sie enthalten keinen Code, und wen sie betreffen, wählst du.</T>
                </View>
              </Row>
            </Card>
          ) : (
            <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
              {plugins.map((p, i) => (
                <Row key={p.id} gap={spacing.md} style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minHeight: TOUCH + 12, borderTopWidth: i ? 1 : 0, borderTopColor: t.border }}>
                  <Text style={{ fontSize: 22 }} accessible={false}>
                    📦
                  </Text>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T style={{ fontWeight: '700' }}>{p.name}</T>
                    <T variant="small">{`von ${p.author} · ${p.templates.length} ${p.templates.length === 1 ? 'Vorlage' : 'Vorlagen'}`}</T>
                  </View>
                  <SmallAction label="Entfernen" a11y={`Plugin ${p.name} entfernen`} color={t.danger} onPress={() => void removePlugin(p)} />
                </Row>
              ))}
            </Card>
          )}
        </Section>

        <Section title="Tipp">
          <Hint>{TIPS[tipIndex] ?? ''}</Hint>
          <Row style={{ justifyContent: 'space-between' }}>
            <T variant="small" style={{ flex: 1 }}>
              {LIMITS_TEXT}
            </T>
          </Row>
          <Button title="Nächster Tipp" kind="ghost" compact onPress={() => setTipIndex((i) => (i + 1) % TIPS.length)} style={{ alignSelf: 'flex-start' }} />
        </Section>
      </Narrow>
    </Screen>
  );
}
