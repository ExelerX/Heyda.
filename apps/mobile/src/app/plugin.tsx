import { CAPABILITY_TEXT, importPlugin, MAX_PLUGIN_BYTES, type ImportResult, type Plugin } from '@heyda/core';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { SentenceText, SmallAction } from '../components/automation/cards';
import { Banner, Bullet, errorText, Field, leave, Narrow } from '../components/setup/kit';
import { Button, Card, Row, Screen, Section, T } from '../components/ui';
import { confirm } from '../lib/confirm';
import { useRuntime, useSnapshot } from '../lib/store';
import { spacing, TOUCH, useTheme } from '../lib/theme';

const EXAMPLE = JSON.stringify(
  {
    format: 'heyda.plugin',
    version: 1,
    id: 'beispiel.familie',
    name: 'Familien-Beispiel',
    description: 'Eine Beispiel-Vorlage: Bescheid, wenn ein Kind an Schultagen in der Schule ankommt.',
    author: 'Heyda.',
    templates: [
      {
        id: 'beispiel.familie.schule-da',
        title: 'In der Schule angekommen',
        sentence: 'Sag mir an Schultagen Bescheid, wenn {contact} bei {place} ankommt',
        category: 'familie',
        slots: [
          { name: 'contact', kind: 'contact', label: 'Kind' },
          { name: 'place', kind: 'place_name', label: 'Schule', default: 'Schule' },
        ],
        rule: {
          name: 'Angekommen: {{slot:place}}',
          trigger: { on: 'contact.arrive', contact: '{{slot:contact}}', place: '{{slot:place}}' },
          conditions: [{ if: 'weekday', days: [1, 2, 3, 4, 5] }],
          actions: [{ do: 'notify', title: '{{contact}} ist in der Schule', body: '{{contact}} ist bei {{place}} angekommen.' }],
        },
      },
    ],
  },
  null,
  2,
);

async function readPickedFile(asset: DocumentPicker.DocumentPickerAsset): Promise<string> {
  if (asset.size !== undefined && asset.size > MAX_PLUGIN_BYTES) throw new Error(`Die Datei ist zu groß. Ein Plugin hat höchstens ${MAX_PLUGIN_BYTES / 1024} KB.`);
  if (Platform.OS === 'web') {
    if (asset.file) return asset.file.text();
    return (await fetch(asset.uri)).text();
  }
  const file = new File(asset.uri);
  if ((file.size ?? 0) > MAX_PLUGIN_BYTES) throw new Error(`Die Datei ist zu groß. Ein Plugin hat höchstens ${MAX_PLUGIN_BYTES / 1024} KB.`);
  try {
    return await file.text();
  } finally {
    try {
      file.delete();
    } catch {
      // The picker's cache copy; the OS cleans it up eventually.
    }
  }
}

export default function PluginImport() {
  const t = useTheme();
  const runtime = useRuntime();
  const { plugins } = useSnapshot();
  const [raw, setRaw] = useState('');
  const [check, setCheck] = useState<ImportResult>();
  const [installed, setInstalled] = useState<Plugin>();
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string>();

  function changeRaw(v: string) {
    setRaw(v);
    setCheck(undefined);
    setInstalled(undefined);
  }

  function runCheck(text = raw) {
    setInstalled(undefined);
    setCheck(importPlugin(text.trim()));
  }

  async function pickFile() {
    setPickError(undefined);
    setPicking(true);
    try {
      const r = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', '*/*'], copyToCacheDirectory: true, multiple: false });
      const asset = r.canceled ? undefined : r.assets[0];
      if (!asset) return;
      const text = (await readPickedFile(asset)).slice(0, MAX_PLUGIN_BYTES);
      changeRaw(text);
      runCheck(text);
    } catch (e) {
      setPickError(errorText(e, 'Die Datei konnte nicht gelesen werden.'));
    } finally {
      setPicking(false);
    }
  }

  async function install() {
    if (!check?.ok) return;
    const replacing = plugins.some((p) => p.id === check.plugin.id);
    if (replacing) {
      const ok = await confirm({ title: 'Plugin ersetzen?', message: `„${check.plugin.name}“ ist schon installiert. Die neue Version ersetzt die alte.`, ok: 'Ersetzen' });
      if (!ok) return;
    }
    const r = runtime.installPlugin(raw.trim());
    if (r.ok) {
      setInstalled(r.plugin);
      setCheck(undefined);
      setRaw('');
    } else setCheck(r);
  }

  async function remove(p: Plugin) {
    const ok = await confirm({
      title: `Plugin „${p.name}“ entfernen?`,
      message: 'Seine Vorlagen verschwinden. Automationen, die du schon daraus eingerichtet hast, laufen weiter.',
      ok: 'Entfernen',
      destructive: true,
    });
    if (ok) runtime.removePlugin(p.id);
  }

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Plugin importieren' }} />
      <Narrow>
        <Card style={{ gap: spacing.sm }}>
          <T variant="h2">📦 Was ist ein Plugin?</T>
          <Bullet icon="🧩">Ein Paket mit Vorlagen für Automationen, z. B. von Freunden geteilt.</Bullet>
          <Bullet icon="🚫">Es enthält nie Programmcode und kann nichts von selbst tun.</Bullet>
          <Bullet icon="🙋">Wen eine Vorlage betrifft und welche Orte sie nutzt, wählst immer du, wenn du sie einrichtest.</Bullet>
        </Card>

        {installed && (
          <Banner tone="success" title={`„${installed.name}“ ist installiert`}>
            <T variant="small" color={t.text}>
              {`${installed.templates.length} ${installed.templates.length === 1 ? 'neue Vorlage steht' : 'neue Vorlagen stehen'} jetzt bei den Automationen. Noch ist nichts aktiv: Richte eine Vorlage ein, wenn du sie nutzen willst.`}
            </T>
            <Button title="Zu den Vorlagen" kind="ghost" compact onPress={() => leave('/automations')} style={{ alignSelf: 'flex-start' }} />
          </Banner>
        )}

        <Section title="Plugin einfügen">
          <Field value={raw} onChangeText={(v) => changeRaw(v.slice(0, MAX_PLUGIN_BYTES))} multiline mono minHeight={150} autoCapitalize="none" placeholder='{ "format": "heyda.plugin", … }' />
          <Row>
            <Button title="Datei wählen" icon="📂" kind="secondary" compact onPress={() => void pickFile()} busy={picking} style={{ flex: 1 }} />
            <Button title="Prüfen" compact onPress={() => runCheck()} disabled={!raw.trim()} style={{ flex: 1 }} />
          </Row>
          {pickError && <T variant="small" color={t.danger}>{pickError}</T>}
          {!raw && (
            <Button
              title="Beispiel zum Ausprobieren einfügen"
              kind="ghost"
              compact
              onPress={() => {
                changeRaw(EXAMPLE);
                runCheck(EXAMPLE);
              }}
            />
          )}
        </Section>

        {check && !check.ok && (
          <Banner tone="danger" title="Das ist kein gültiges Plugin">
            <T variant="small" color={t.text}>
              Prüfe, ob du den ganzen Text kopiert hast. Wer das Plugin gemacht hat, kann mit diesen Hinweisen etwas anfangen:
            </T>
            {check.errors.slice(0, 6).map((e) => (
              <Text key={e} style={{ color: t.textMuted, fontSize: 12 }}>{`• ${e}`}</Text>
            ))}
            {check.errors.length > 6 && <T variant="small">{`… und ${check.errors.length - 6} weitere`}</T>}
          </Banner>
        )}

        {check?.ok && (
          <>
            <Section title="Das steckt drin">
              <Card style={{ gap: spacing.xs, borderColor: t.accent }}>
                <T variant="h2">{check.plugin.name}</T>
                <T variant="small">{`von ${check.plugin.author}`}</T>
                {check.plugin.description ? <T variant="muted">{check.plugin.description}</T> : null}
                {plugins.some((p) => p.id === check.plugin.id) && <T variant="small" color={t.accent}>Schon installiert: Die neue Version ersetzt die alte.</T>}
              </Card>
            </Section>
            <Section title="Seine Vorlagen können">
              <Card style={{ gap: spacing.sm }}>
                {check.capabilities.map((c) => (
                  <Bullet key={c} icon="•">
                    {CAPABILITY_TEXT[c]}
                  </Bullet>
                ))}
                <T variant="small">Aber nur für die Personen und Orte, die du beim Einrichten auswählst.</T>
              </Card>
            </Section>
            <Section title={`${check.plugin.templates.length} ${check.plugin.templates.length === 1 ? 'Vorlage' : 'Vorlagen'}`}>
              {check.plugin.templates.map((tpl) => (
                <Card key={tpl.id} style={{ gap: 4 }}>
                  <T variant="h2">{tpl.title}</T>
                  <SentenceText template={tpl} />
                </Card>
              ))}
            </Section>
            <Button title="Installieren" icon="📦" onPress={() => void install()} style={{ marginTop: spacing.md }} />
            <T variant="small">Installieren macht noch nichts: Die Vorlagen erscheinen nur in der Liste.</T>
          </>
        )}

        <Section title="Installierte Plugins">
          {plugins.length === 0 ? (
            <T variant="muted">Noch keine.</T>
          ) : (
            <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
              {plugins.map((p, i) => (
                <Row key={p.id} gap={spacing.md} style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minHeight: TOUCH + 12, borderTopWidth: i ? 1 : 0, borderTopColor: t.border }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T style={{ fontWeight: '700' }}>{p.name}</T>
                    <T variant="small">{`von ${p.author} · ${p.templates.length} ${p.templates.length === 1 ? 'Vorlage' : 'Vorlagen'}`}</T>
                  </View>
                  <SmallAction label="Entfernen" a11y={`Plugin ${p.name} entfernen`} color={t.danger} onPress={() => void remove(p)} />
                </Row>
              ))}
            </Card>
          )}
        </Section>
      </Narrow>
    </Screen>
  );
}
