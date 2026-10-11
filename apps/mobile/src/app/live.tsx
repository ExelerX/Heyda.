import { contactLabel } from '@heyda/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ContactPicker } from '../components/social/ContactPicker';
import { joinNames } from '../components/social/contacts';
import { cellSize, levelWords } from '../components/social/describe';
import { durationWords, errorText, hhmm, remaining } from '../components/social/format';
import { Choice, ListCard, ListRow, Narrow } from '../components/social/kit';
import { canLocate, ensureFix, ensureTrackingAccess, NO_GPS_TEXT } from '../components/social/location';
import { contactKeyParam } from '../components/social/params';
import { Avatar, Button, Card, Chip, Empty, Hint, Row, Screen, Section, T, Wrap } from '../components/ui';
import { confirm, notice } from '../lib/confirm';
import { useRuntime, useSnapshot, useTick } from '../lib/store';
import { spacing, useTheme } from '../lib/theme';

const MIN = 60_000;
const DURATIONS = [15 * MIN, 60 * MIN, 8 * 60 * MIN, 24 * 60 * MIN];

export default function LiveScreen() {
  const t = useTheme();
  const runtime = useRuntime();
  const params = useLocalSearchParams<{ to?: string | string[] }>();
  const { state, isDemo } = useSnapshot();
  const now = useTick(15_000);
  const located = canLocate(isDemo);
  const preset = contactKeyParam(params.to);

  const [selected, setSelected] = useState<string[]>(() =>
    preset && state.contacts.some((c) => c.key === preset) ? [preset] : state.contacts.length === 1 ? [state.contacts[0]!.key] : [],
  );
  const [level, setLevel] = useState<'coarse' | 'precise'>('coarse');
  const [duration, setDuration] = useState(DURATIONS[1]!);
  const [busy, setBusy] = useState<string>();

  const nameOf = (key: string) => contactLabel(state.contacts.find((c) => c.key === key));
  const shares = state.liveShares.filter((s) => !s.expiresAt || s.expiresAt > now);
  const sharingWith = new Set(shares.map((s) => s.contactKey));

  async function start() {
    if (!selected.length || busy) return;
    setBusy('start');
    try {
      if (!isDemo) {
        const access = await ensureTrackingAccess(false);
        if (access === 'denied') {
          notice('Standort nötig', 'Ohne Standortzugriff kann Heyda. nichts live teilen. Du kannst ihn in den Einstellungen deines Handys erlauben.');
          return;
        }
        if (access === 'while-using') {
          notice(
            'Nur solange die App offen ist',
            'Heyda. darf deinen Standort nur nutzen, solange die App offen ist. Damit er auch mit gesperrtem Handy aktuell bleibt, erlaube in den Einstellungen „Immer“.',
          );
        }
      }
      await ensureFix(runtime);
      await runtime.node.startLive({ contacts: selected, level, durationMs: duration });
      setSelected([]);
    } catch (e) {
      notice('Nicht gestartet', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function stop(key?: string) {
    if (!key) {
      const ok = await confirm({ title: 'Alle Live-Standorte beenden?', ok: 'Alle beenden' });
      if (!ok) return;
    }
    setBusy(key ?? 'all');
    try {
      await runtime.node.stopLive(key);
    } catch (e) {
      notice('Hat nicht geklappt', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function ghostOff() {
    setBusy('ghost');
    try {
      await runtime.node.setGhost(false);
    } catch (e) {
      notice('Hat nicht geklappt', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Standort live teilen' }} />
      <Narrow>
        {shares.length ? (
          <Section title="Du teilst gerade">
            <ListCard>
              {shares.map((s, i) => (
                <ListRow key={s.shareId} first={i === 0}>
                  <Row gap={spacing.md}>
                    <Avatar name={nameOf(s.contactKey)} keyHex={s.contactKey} size={36} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <T numberOfLines={1}>{nameOf(s.contactKey)}</T>
                      <T variant="small" color={t.success}>
                        {`📡 ${levelWords(s.level)} · ${s.expiresAt ? `${remaining(s.expiresAt, now)} (bis ${hhmm(s.expiresAt)})` : 'bis du es beendest'}`}
                      </T>
                    </View>
                    <Button title="Beenden" kind="secondary" compact busy={busy === s.contactKey} onPress={() => void stop(s.contactKey)} />
                  </Row>
                </ListRow>
              ))}
            </ListCard>
            {shares.length > 1 ? <Button title="Alle beenden" kind="danger" compact busy={busy === 'all'} onPress={() => void stop()} /> : null}
          </Section>
        ) : null}

        {!state.contacts.length ? (
          <Empty
            icon="📡"
            title="Mit wem teilen?"
            text="Füge zuerst Familie oder Freunde hinzu. Dann kannst du ihnen zeigen, wo du gerade ungefähr bist."
            action={<Button title="Freund hinzufügen" icon="🤝" onPress={() => router.replace('/pair')} />}
          />
        ) : state.ghost ? (
          <Card style={{ gap: spacing.md, borderColor: t.info }}>
            <T variant="h2">👻 Der Geistmodus ist an</T>
            <T variant="muted">
              Solange er an ist, verlässt dein Standort das Handy nicht automatisch – auch kein Live-Standort. Ein Notruf (SOS) geht
              trotzdem raus.
            </T>
            <Button title="Geistmodus ausschalten" onPress={() => void ghostOff()} busy={busy === 'ghost'} />
          </Card>
        ) : !located ? (
          <Card style={{ gap: spacing.sm }}>
            <T variant="h2">📱 Dafür brauchst du dein Handy</T>
            <T variant="muted">{`${NO_GPS_TEXT} Starte den Live-Standort in der App auf deinem Handy.`}</T>
          </Card>
        ) : (
          <>
            <T variant="muted">
              {shares.length
                ? 'Mit noch jemandem teilen? Ausgewählte Personen sehen auf ihrer Karte, wo du bist, bis die Zeit um ist.'
                : 'Wie bei Snapchat: Ausgewählte Personen sehen auf ihrer Karte, wo du bist – bis die Zeit um ist oder du es beendest.'}
            </T>

            <Section title="Mit wem?">
              <ContactPicker
                contacts={state.contacts}
                selected={selected}
                onChange={setSelected}
                note={(c) => (sharingWith.has(c.key) ? 'teilt schon – wird ersetzt' : undefined)}
              />
            </Section>

            <Section title="Wie genau?">
              <Choice
                title={`Ungefähr (${cellSize()})`}
                icon="🗺️"
                detail={`Sie sehen nur ein Feld von etwa ${cellSize().slice(1)} × ${cellSize().slice(1)}, in dem du bist – nie die Straße. Spart auch Akku.`}
                selected={level === 'coarse'}
                onPress={() => setLevel('coarse')}
              />
              <Choice
                title="Genau"
                icon="📌"
                detail="Sie sehen deinen genauen Standort auf der Karte, laufend aktualisiert. Gut für Treffen und Abholen."
                selected={level === 'precise'}
                onPress={() => setLevel('precise')}
              />
            </Section>

            <Section title="Wie lange?">
              <Wrap>
                {DURATIONS.map((d) => (
                  <Chip key={d} label={durationWords(d)} selected={duration === d} onPress={() => setDuration(d)} />
                ))}
              </Wrap>
              <T variant="small">{`Endet von selbst um ${hhmm(now + duration)}. Du kannst jederzeit früher beenden.`}</T>
            </Section>

            <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
              <Button
                title={selected.length ? `Mit ${joinNames(selected.map(nameOf))} teilen` : 'Live teilen'}
                icon="📡"
                onPress={() => void start()}
                disabled={!selected.length}
                busy={busy === 'start'}
              />
              {!selected.length ? (
                <T variant="small" style={{ textAlign: 'center' }}>
                  Wähle mindestens eine Person.
                </T>
              ) : null}
              {isDemo ? (
                <T variant="small" style={{ textAlign: 'center' }}>
                  🧪 Demo: Es wird ein ausgedachter Standort benutzt, nie dein echter.
                </T>
              ) : (
                <Hint>Damit es auch mit gesperrtem Handy weiterläuft, fragt Heyda. nach dem Standort „Immer“. Du siehst dann einen Hinweis in der Statusleiste.</Hint>
              )}
            </View>
          </>
        )}
      </Narrow>
    </Screen>
  );
}
