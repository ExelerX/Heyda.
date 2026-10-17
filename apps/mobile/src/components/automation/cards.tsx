import { describeRule, type Rule, type RuleTemplate, type SlotValues } from '@heyda/core';
import { router } from 'expo-router';
import { Platform, Pressable, Switch, Text, View } from 'react-native';
import { useContactName, useSentName, useSnapshot } from '../../lib/store';
import { CATEGORY_ICON, isPluginTemplate, sentenceParts } from '../../lib/templates-ui';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';
import { Card, Pill, Row, T } from '../ui';

/** A template sentence with its gaps highlighted: open gaps dashed, filled ones in accent. */
export function SentenceText({ template, values, size = 'body' }: { template: RuleTemplate; values?: SlotValues; size?: 'body' | 'big' }) {
  const t = useTheme();
  const { state } = useSnapshot();
  const parts = sentenceParts(template, values ?? {}, values ? state : undefined);
  const fontSize = size === 'big' ? 22 : 16;
  const lineHeight = size === 'big' ? 32 : 24;
  return (
    <Text style={{ color: t.text, fontSize, lineHeight, fontWeight: size === 'big' ? '700' : '400' }}>
      {parts.map((p, i) =>
        p.slot ? (
          <Text
            key={i}
            style={{
              color: p.filled ? t.accent : t.textMuted,
              fontWeight: '700',
              textDecorationLine: p.filled ? 'none' : 'underline',
              textDecorationStyle: 'dashed',
            }}
          >
            {p.filled ? p.text : `[${p.text}]`}
          </Text>
        ) : (
          <Text key={i}>{p.text}</Text>
        ),
      )}
    </Text>
  );
}

export function TemplateCard({ template, pluginName }: { template: RuleTemplate; pluginName?: string }) {
  const t = useTheme();
  return (
    <Card onPress={() => router.push(`/template/${encodeURIComponent(template.id)}`)} label={`Vorlage ${template.title}`}>
      <Row style={{ alignItems: 'flex-start' }}>
        <Text style={{ fontSize: 22 }} accessible={false}>
          {CATEGORY_ICON[template.category]}
        </Text>
        <View style={{ flex: 1, gap: 4 }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <T variant="h2" style={{ flex: 1 }}>
              {template.title}
            </T>
            {isPluginTemplate(template) && <Pill text={pluginName ? `📦 ${pluginName}` : '📦 Plugin'} color={t.info} />}
          </Row>
          <SentenceText template={template} />
        </View>
        <Text style={{ color: t.textMuted, fontSize: 22 }} accessible={false}>
          ›
        </Text>
      </Row>
    </Card>
  );
}

/**
 * react-native-web colours the "on" thumb with its own teal unless told otherwise, and draws the
 * switch 40×20 (also in the Windows app): too small a target.
 */
const WEB_SWITCH = (t: { surface: string; text: string; dark: boolean }) =>
  (Platform.OS === 'web' ? { activeThumbColor: t.dark ? t.text : t.surface, style: { height: 28 } } : {}) as object;

const SOURCE_TEXT: Record<Rule['source'], string> = {
  template: 'Vorlage',
  plugin: 'Plugin',
  blocks: 'Eigene',
  manual: 'Eigene',
  ai: 'Vorschlag',
};

/** One of my rules: plain sentence, on/off, edit and delete. */
export function RuleCard({ rule, onToggle, onDelete }: { rule: Rule; onToggle: (on: boolean) => void; onDelete: () => void }) {
  const t = useTheme();
  const { state } = useSnapshot();
  const contactName = useContactName();
  const sentName = useSentName();
  const placeName = (id: string) => state.places.find((p) => p.id === id)?.name ?? 'einem gelöschten Ort';
  const sentence = describeRule(rule, { contactName, sentName, placeName });
  return (
    <Card style={{ gap: spacing.sm, opacity: rule.enabled ? 1 : 0.75 }}>
      <Row gap={spacing.md} style={{ alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Row gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
            <T variant="h2">{rule.name}</T>
            <Pill text={SOURCE_TEXT[rule.source]} color={t.textMuted} />
            {!rule.enabled && <Pill text="Pausiert" color={t.accent} />}
          </Row>
          <T variant="muted">{sentence}</T>
        </View>
        <Switch
          {...WEB_SWITCH(t)}
          value={rule.enabled}
          onValueChange={onToggle}
          trackColor={{ true: t.accent, false: t.border }}
          thumbColor={t.dark ? t.text : t.surface}
          accessibilityLabel={`${rule.name} ${rule.enabled ? 'ausschalten' : 'einschalten'}`}
        />
      </Row>
      <Row style={{ justifyContent: 'flex-end' }} gap={spacing.xs}>
        <SmallAction label="Bearbeiten" a11y={`${rule.name} bearbeiten`} color={t.accent} onPress={() => router.push(`/rule/${encodeURIComponent(rule.id)}`)} />
        <SmallAction label="Löschen" a11y={`${rule.name} löschen`} color={t.danger} onPress={onDelete} />
      </Row>
    </Card>
  );
}

export function SmallAction({ label, a11y, color, onPress }: { label: string; a11y?: string; color: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      style={({ pressed }) => ({ minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.sm, opacity: pressed ? 0.6 : 1 })}
    >
      <Text style={{ color, fontWeight: '700', fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}
