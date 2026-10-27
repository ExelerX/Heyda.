import { describeRule, randomId, type Rule } from '@heyda/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { AddPiece, Block, BlockOption, Connector, PartLabel } from '../../components/automation/Block';
import {
  ACTIONS,
  actionInfo,
  autoName,
  buildRule,
  CONDITIONS,
  conditionInfo,
  LIMITS_TEXT,
  MAX_ACTIONS,
  MAX_CONDITIONS,
  newAction,
  newCondition,
  newTrigger,
  TRIGGERS,
  triggerInfo,
  type Draft,
  type Obj,
} from '../../components/automation/catalog';
import { ActionParams, ConditionParams, TriggerParams } from '../../components/automation/params';
import { Banner, Bullet, errorText, Field, leave, Narrow, NotFound, param } from '../../components/setup/kit';
import { Button, Card, Screen, T, Toggle } from '../../components/ui';
import { confirm, notice } from '../../lib/confirm';
import { useContactName, useRuntime, useSentName, useSnapshot } from '../../lib/store';
import { spacing, useTheme } from '../../lib/theme';

export default function RuleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state } = useSnapshot();
  const ruleId = param(id);
  if (ruleId === 'new') return <Builder />;
  const rule = /^[A-Za-z0-9_-]{8,64}$/.test(ruleId) ? state.rules.find((r) => r.id === ruleId) : undefined;
  if (!rule) {
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: 'Automation' }} />
        <Narrow>
          <NotFound
            title="Automation nicht gefunden"
            text="Diese Automation gibt es nicht (mehr). Vielleicht wurde sie auf einem anderen Gerät gelöscht."
            action={<Button title="Zu den Automationen" kind="secondary" onPress={() => router.replace('/automations')} />}
          />
        </Narrow>
      </Screen>
    );
  }
  return <Builder key={rule.id} initial={rule} />;
}

function fromRule(rule: Rule): Draft {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    trigger: { ...rule.trigger },
    conditions: rule.conditions.map((c) => ({ ...c })),
    actions: rule.actions.map((a) => ({ ...a })),
    source: rule.source,
    templateId: rule.templateId,
  };
}

type Picking = 'trigger' | 'condition' | 'action' | undefined;

function Builder({ initial }: { initial?: Rule }) {
  const t = useTheme();
  const runtime = useRuntime();
  const { state } = useSnapshot();
  const contactName = useContactName();
  const sentName = useSentName();
  const [draft, setDraft] = useState<Draft>(() =>
    initial ? fromRule(initial) : { id: randomId(), name: '', enabled: true, conditions: [], actions: [], source: 'blocks' },
  );
  const [picking, setPicking] = useState<Picking>(initial ? undefined : 'trigger');
  const [tried, setTried] = useState(false);

  const colors = { when: t.accent, only: t.info, then: t.success };
  const result = useMemo(() => buildRule(draft, state), [draft, state]);
  const preview = useMemo(() => {
    if (!draft.trigger || !draft.actions.length) return undefined;
    const names = {
      contactName: (k: string) => (k ? contactName(k) : '[Person]'),
      sentName: (k: string) => (k ? sentName(k) : '[Person]'),
      placeName: (pid: string) => state.places.find((p) => p.id === pid)?.name ?? '[Ort]',
    };
    if (result.ok) return describeRule(result.rule, names);
    // Still incomplete: describe what is there, with placeholders for the gaps.
    try {
      return describeRule({ ...(draft as unknown as Rule), trigger: draft.trigger as Rule['trigger'] }, names);
    } catch {
      return undefined;
    }
  }, [draft, result, state.places, contactName, sentName]);

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const patchTrigger = (patch: Obj) => setDraft((d) => (d.trigger ? { ...d, trigger: { ...d.trigger, ...patch } } : d));
  const patchCondition = (i: number, patch: Obj) => setDraft((d) => ({ ...d, conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const patchAction = (i: number, patch: Obj) => setDraft((d) => ({ ...d, actions: d.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) }));

  function save() {
    setTried(true);
    if (!result.ok) return;
    try {
      runtime.saveRule(result.rule);
      leave('/automations');
    } catch (e) {
      notice('Nicht gespeichert', errorText(e));
    }
  }

  async function remove() {
    if (!initial) return;
    const ok = await confirm({ title: `„${initial.name}“ löschen?`, message: 'Die Automation ist dann weg.', ok: 'Löschen', destructive: true });
    if (!ok) return;
    leave('/automations');
    runtime.removeRule(initial.id);
  }

  const trig = draft.trigger ? triggerInfo(draft.trigger.on) : undefined;

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: initial ? 'Automation bearbeiten' : 'Eigene Automation' }} />
      <Narrow>
        <T variant="muted">Steck deine Automation aus Bausteinen zusammen: Wann soll sie starten, wann nur, und was soll dann passieren?</T>

        {/* ---- Wenn ---- */}
        <PartLabel text="Wenn" color={colors.when} hint="Was löst sie aus?" />
        {draft.trigger && trig && picking !== 'trigger' ? (
          <Block color={colors.when} icon={trig.icon} title={trig.title} onChange={() => setPicking('trigger')}>
            <TriggerParams trigger={draft.trigger} onPatch={patchTrigger} />
            {trig.needs ? <Bullet icon="ℹ️">{trig.needs}</Bullet> : null}
          </Block>
        ) : (
          <Card style={{ gap: spacing.md }}>
            <T variant="h2">Wenn Freunde etwas tun</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {TRIGGERS.filter((x) => x.group === 'friend').map((x) => (
                <BlockOption
                  key={x.key}
                  color={colors.when}
                  icon={x.icon}
                  title={x.title}
                  detail={x.detail}
                  selected={draft.trigger?.on === x.key}
                  onPress={() => {
                    update({ trigger: newTrigger(x.key, draft.trigger, state) });
                    setPicking(undefined);
                  }}
                />
              ))}
            </View>
            <T variant="h2">Wenn ich …</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {TRIGGERS.filter((x) => x.group === 'me').map((x) => (
                <BlockOption
                  key={x.key}
                  color={colors.when}
                  icon={x.icon}
                  title={x.title}
                  detail={x.detail}
                  selected={draft.trigger?.on === x.key}
                  onPress={() => {
                    update({ trigger: newTrigger(x.key, draft.trigger, state) });
                    setPicking(undefined);
                  }}
                />
              ))}
            </View>
            {draft.trigger && <Button title="Abbrechen" kind="ghost" compact onPress={() => setPicking(undefined)} />}
          </Card>
        )}

        {/* ---- Und nur wenn ---- */}
        <Connector color={colors.only} />
        <PartLabel text="Und nur wenn" color={colors.only} hint="Freiwillig: grenzt sie ein." />
        {draft.conditions.map((c, i) => {
          const info = conditionInfo(c.if);
          return (
            <Block
              key={i}
              color={colors.only}
              icon={info?.icon ?? '❔'}
              title={info?.title ?? 'Bedingung'}
              onRemove={() => update({ conditions: draft.conditions.filter((_, j) => j !== i) })}
            >
              <ConditionParams condition={c} onPatch={(p) => patchCondition(i, p)} />
            </Block>
          );
        })}
        {picking === 'condition' ? (
          <Card style={{ gap: spacing.sm }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {CONDITIONS.map((x) => (
                <BlockOption
                  key={x.key}
                  color={colors.only}
                  icon={x.icon}
                  title={x.title}
                  detail={x.detail}
                  onPress={() => {
                    update({ conditions: [...draft.conditions, newCondition(x.key, state)] });
                    setPicking(undefined);
                  }}
                />
              ))}
            </View>
            <Button title="Abbrechen" kind="ghost" compact onPress={() => setPicking(undefined)} />
          </Card>
        ) : (
          <AddPiece label="Bedingung" color={colors.only} onPress={() => setPicking('condition')} disabled={draft.conditions.length >= MAX_CONDITIONS} />
        )}

        {/* ---- Dann ---- */}
        <Connector color={colors.then} />
        <PartLabel text="Dann" color={colors.then} hint="Was soll passieren?" />
        {draft.actions.map((a, i) => {
          const info = actionInfo(a.do);
          return (
            <Block
              key={i}
              color={colors.then}
              icon={info?.icon ?? '❔'}
              title={info?.title ?? 'Aktion'}
              onRemove={() => update({ actions: draft.actions.filter((_, j) => j !== i) })}
            >
              <ActionParams action={a} trigger={draft.trigger} onPatch={(p) => patchAction(i, p)} />
            </Block>
          );
        })}
        {picking === 'action' || (draft.trigger && !draft.actions.length && picking === undefined) ? (
          <Card style={{ gap: spacing.sm }}>
            <T variant="h2">Was soll passieren?</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {ACTIONS.map((x) => (
                <BlockOption
                  key={x.key}
                  color={colors.then}
                  icon={x.icon}
                  title={x.title}
                  detail={x.detail}
                  onPress={() => {
                    update({ actions: [...draft.actions, newAction(x.key, draft.trigger, state)] });
                    setPicking(undefined);
                  }}
                />
              ))}
            </View>
            {draft.actions.length > 0 && <Button title="Abbrechen" kind="ghost" compact onPress={() => setPicking(undefined)} />}
          </Card>
        ) : (
          <AddPiece
            label={draft.actions.length ? 'Noch eine Aktion' : 'Aktion'}
            color={colors.then}
            onPress={() => setPicking('action')}
            disabled={draft.actions.length >= MAX_ACTIONS || !draft.trigger}
          />
        )}

        {/* ---- Vorschau und Speichern ---- */}
        <View style={{ gap: spacing.md, marginTop: spacing.xl }}>
          <Field
            label="Name (freiwillig)"
            value={draft.name}
            onChangeText={(name) => update({ name })}
            maxLength={60}
            placeholder={autoName(draft, state)}
            hint="Steht in deiner Liste. Leer lassen geht auch."
          />
          {initial && (
            <Card>
              <Toggle label="Aktiv" detail="Ausgeschaltet bleibt die Automation gespeichert, tut aber nichts." value={draft.enabled} onChange={(enabled) => update({ enabled })} />
            </Card>
          )}
          {preview ? (
            <Banner tone={result.ok ? 'success' : 'info'} icon="🗣️" title={result.ok ? 'So liest sich deine Automation' : 'Vorschau (noch unvollständig)'}>
              {preview}
            </Banner>
          ) : (
            <Banner tone="info" icon="🗣️" title="Vorschau">
              Wähle oben, wann es losgehen soll und was dann passiert. Hier steht dann in einem Satz, was deine Automation tut.
            </Banner>
          )}
          {!result.ok && result.errors.length > 0 && (
            <Card style={{ gap: spacing.xs, borderColor: tried ? t.danger : t.border }}>
              <T variant="h2" color={tried ? t.danger : t.text}>
                Noch offen
              </T>
              {result.errors.map((e) => (
                <T key={e} variant="small">{`• ${e}`}</T>
              ))}
            </Card>
          )}
          <Button title={initial ? 'Änderungen speichern' : 'Automation speichern'} icon="⚡" onPress={save} disabled={tried && !result.ok} />
          <T variant="small">{LIMITS_TEXT}</T>
          {initial && <Button title="Automation löschen" kind="danger" onPress={() => void remove()} />}
        </View>
      </Narrow>
    </Screen>
  );
}
