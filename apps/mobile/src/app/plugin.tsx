import { CAPABILITY_TEXT, importPlugin, type ImportResult } from '@social-app/core';
import { router } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Button, Card, Hint, Screen, Section, T } from '../components/ui';
import { useRuntime } from '../lib/store';
import { radius, spacing, useTheme } from '../lib/theme';

export default function PluginImport() {
  const t = useTheme();
  const runtime = useRuntime();
  const [raw, setRaw] = useState('');
  const [check, setCheck] = useState<ImportResult>();

  return (
    <Screen edges={['bottom']}>
      <Hint>
        Ein Plugin ist ein Paket aus Vorlagen. Es enthält keinen Code und kann niemanden von selbst auswählen: Personen und
        Orte setzt immer du ein.
      </Hint>
      <TextInput
        value={raw}
        onChangeText={(v) => {
          setRaw(v);
          setCheck(undefined);
        }}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Plugin-Text hier einfügen"
        placeholderTextColor={t.textMuted}
        accessibilityLabel="Plugin-Text"
        style={{
          minHeight: 160,
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: radius.md,
          color: t.text,
          fontFamily: 'monospace',
          fontSize: 13,
          padding: spacing.md,
          textAlignVertical: 'top',
        }}
      />
      {!check && <Button title="Prüfen" onPress={() => setCheck(importPlugin(raw))} disabled={!raw.trim()} />}

      {check && !check.ok && (
        <Card style={{ borderColor: t.danger }}>
          <T variant="h2" color={t.danger}>
            Nicht installierbar
          </T>
          {check.errors.slice(0, 8).map((e) => (
            <T key={e} variant="small">
              • {e}
            </T>
          ))}
        </Card>
      )}

      {check?.ok && (
        <>
          <Card>
            <T variant="h2">{check.plugin.name}</T>
            <T variant="small">von {check.plugin.author}</T>
            {check.plugin.description ? <T variant="muted">{check.plugin.description}</T> : null}
          </Card>
          <Section title="Das kann es">
            {check.capabilities.map((c) => (
              <T key={c}>• {CAPABILITY_TEXT[c]}</T>
            ))}
          </Section>
          <Section title={`${check.plugin.templates.length} Vorlagen`}>
            {check.plugin.templates.map((tpl) => (
              <T key={tpl.id} variant="muted">
                ⚡ {tpl.title}: {tpl.sentence}
              </T>
            ))}
          </Section>
          <View style={{ marginTop: spacing.lg }}>
            <Button
              title="Installieren"
              onPress={() => {
                if (runtime.installPlugin(raw).ok) router.back();
              }}
            />
          </View>
        </>
      )}
    </Screen>
  );
}
