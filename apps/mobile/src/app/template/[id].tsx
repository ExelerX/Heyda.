import { describeRule, instantiateTemplate, type RuleTemplate, type SlotDef, type SlotValues } from '@heyda/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { LIMITS_TEXT, triggerInfo } from '../../components/automation/catalog';
import { SentenceText } from '../../components/automation/cards';
import { ContactPick, NumberPick, PlacePick } from '../../components/automation/pickers';
import { Banner, Bullet, errorText, Field, leave, Narrow, NotFound, param } from '../../components/setup/kit';
import { Button, Card, Chip, Pill, Screen, Section, T, Wrap } from '../../components/ui';
import { notice } from '../../lib/confirm';
import { useContactName, useRuntime, useSentName, useSnapshot } from '../../lib/store';
import { durationLabel, isPluginTemplate } from '../../lib/templates-ui';
import { spacing, useTheme } from '../../lib/theme';

const PLACE_SUGGESTIONS = ['Zuhause', 'Arbeit', 'Schule', 'Supermarkt', 'Sport'];
const MINUTE_PRESETS = [
  { value: 0, label: 'gleich da' },
  { value: 2, label: '2 Min.' },
  { value: 5, label: '5 Min.' },
  { value: 10, label: '10 Min.' },
  { value: 15, label: '15 Min.' },
  { value: 30, label: '30 Min.' },
];
const DURATION_PRESETS = [30, 60, 120, 240, 480, 720, 1440].map((m) => ({ value: m, label: durationLabel(m) }));

export default function TemplateScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { templates } = useSnapshot();
  const templateId = param(id);
  const template = templates.find((x) => x.id === templateId);

  if (!template) {
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: 'Vorlage' }} />
        <Narrow>
          <NotFound
            title="Vorlage nicht gefunden"
            text="Diese Vorlage gibt es nicht (mehr). Vielleicht wurde das Plugin entfernt."
            action={<Button title="Zu den Automationen" kind="secondary" onPress={() => router.replace('/automations')} />}
          />
        </Narrow>
      </Screen>
    );
  }
  return <TemplateForm key={template.id} template={template} />;
}

function TemplateForm({ template }: { template: RuleTemplate }) {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, plugins } = useSnapshot();
  const contactName = useContactName();
  const sentName = useSentName();
  // A person is never filled in ahead, only "anyone" (the import refuses anything else too).
  const [values, setValues] = useState<SlotValues>(() =>
    Object.fromEntries(
      template.slots.flatMap((s) => (s.default !== undefined && (s.kind !== 'contact' || s.default === 'any') ? [[s.name, s.default]] : [])),
    ),
  );
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);

  const preview = useMemo(() => instantiateTemplate(template, values, { id: 'preview-rule' }), [template, values]);
  const placeName = (pid: string) => state.places.find((p) => p.id === pid)?.name ?? '?';
  const plugin = isPluginTemplate(template) ? plugins.find((p) => p.templates.some((x) => x.id === template.id)) : undefined;
  const needs = triggerInfo(template.rule.trigger.on)?.needs;
  const sharesEta = template.rule.actions.some((a) => a.do === 'start_trip');
  const set = (name: string, value: string | number) => setValues((v) => ({ ...v, [name]: value }));

  function save() {
    setTried(true);
    if (saving) return;
    setSaving(true);
    try {
      const r = instantiateTemplate(template, values, { source: plugin ? 'plugin' : 'template' });
      if (!r.ok) return;
      runtime.saveRule(r.value);
      leave('/automations');
    } catch (e) {
      notice('Nicht gespeichert', errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: template.title }} />
      <Narrow>
        <Card style={{ borderColor: t.accent, borderWidth: 1, gap: spacing.sm }}>
          <T variant="small">So lautet deine Automation:</T>
          <SentenceText template={template} values={values} size="big" />
          {plugin && (
            <View style={{ alignSelf: 'flex-start' }}>
              <Pill text={`📦 Aus dem Plugin „${plugin.name}“ von ${plugin.author}`} color={t.info} />
            </View>
          )}
        </Card>
        <T variant="muted">Fülle die Lücken aus. Erst wenn du speicherst, wird die Automation aktiv.</T>

        {template.slots.map((slot) => (
          <Section key={slot.name} title={slot.label}>
            <SlotInput slot={slot} value={values[slot.name]} onChange={(v) => set(slot.name, v)} />
          </Section>
        ))}

        {needs && (
          <View style={{ marginTop: spacing.lg }}>
            <Bullet icon="ℹ️">{needs}</Bullet>
          </View>
        )}
        {sharesEta && <Bullet icon="🔒">Automationen teilen nur deine Ankunftszeit, nie deinen Standort. Dein Gerät zeigt an, solange geteilt wird.</Bullet>}

        <View style={{ marginTop: spacing.lg, gap: spacing.md }}>
          {preview.ok ? (
            <Banner tone="success" title="So funktioniert es">
              {describeRule(preview.value, { contactName, sentName, placeName })}
            </Banner>
          ) : (
            <Card style={{ gap: spacing.xs, borderColor: tried ? t.danger : t.border }}>
              <T variant="h2" color={tried ? t.danger : t.text}>
                Noch offen
              </T>
              {preview.errors.map((e) => (
                <T key={e} variant="small">{`• ${e}`}</T>
              ))}
            </Card>
          )}
          <Button title="Automation speichern" icon="⚡" onPress={save} disabled={!preview.ok} busy={saving} />
          <T variant="small">{LIMITS_TEXT}</T>
        </View>
      </Narrow>
    </Screen>
  );
}

function SlotInput({ slot, value, onChange }: { slot: SlotDef; value: string | number | undefined; onChange: (v: string | number) => void }) {
  const t = useTheme();
  const { statuses } = useSnapshot();
  // Names friends actually used for their places, so "Supermarkt" matches what they send.
  const seen = useMemo(() => {
    const names = new Set<string>();
    for (const s of Object.values(statuses)) if (s.lastPlace?.placeName) names.add(s.lastPlace.placeName);
    return [...names].slice(0, 8);
  }, [statuses]);

  switch (slot.kind) {
    case 'contact':
      return <ContactPick value={value} onChange={onChange} allowAny={slot.allowAny} />;
    case 'my_place':
      return <PlacePick value={value} onChange={onChange} />;
    case 'minutes':
      return <NumberPick value={value} onChange={onChange} presets={MINUTE_PRESETS} min={0} max={120} unit="Minuten" label="Minuten" />;
    case 'duration':
      return <NumberPick value={value} onChange={onChange} presets={DURATION_PRESETS} min={15} max={1440} unit="Minuten" label="Dauer in Minuten" />;
    case 'place_name': {
      const suggestions = [...new Set([...seen, ...PLACE_SUGGESTIONS])];
      return (
        <View style={{ gap: spacing.sm }}>
          <Field value={typeof value === 'string' ? value : ''} onChangeText={onChange} maxLength={60} placeholder="Name des Ortes" />
          <Wrap>
            {suggestions.map((p) => (
              <Chip key={p} icon={seen.includes(p) ? '👀' : undefined} label={p} selected={value === p} onPress={() => onChange(p)} />
            ))}
          </Wrap>
          <T variant="small" color={t.textMuted}>
            So, wie die andere Person ihren Ort genannt hat (Groß- und Kleinschreibung egal). 👀 = schon bei dir angekommen.
          </T>
        </View>
      );
    }
    case 'text':
      return <Field value={typeof value === 'string' ? value : ''} onChangeText={onChange} maxLength={200} counter multiline minHeight={80} placeholder={slot.label} />;
  }
}
