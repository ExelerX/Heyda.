import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Bullet, errorText, Field, MenuGroup, MenuRow, Narrow } from '../../components/setup/kit';
import { Avatar, Button, Card, Pill, Row, Screen, Section, T, Toggle } from '../../components/ui';
import { confirm, notice } from '../../lib/confirm';
import { isBrowserPreview } from '../../lib/platform';
import { useContactName, useRestart, useRuntime, useSnapshot, useTick } from '../../lib/store';
import { spacing, TOUCH, useTheme } from '../../lib/theme';

const NAME_MAX = 40;

function hhmm(at: number): string {
  return new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function people(n: number): string {
  return n === 1 ? '1 Person' : `${n} Personen`;
}

export default function Me() {
  const t = useTheme();
  const runtime = useRuntime();
  const restart = useRestart();
  const contactName = useContactName();
  const { state, isDemo, dndActive, dndEndsAt } = useSnapshot();
  const now = useTick(30_000);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(state.self.name);
  const [savingName, setSavingName] = useState(false);
  const [ending, setEnding] = useState(false);

  const status = state.status && state.status.expiresAt > now ? state.status : undefined;
  const statusText = status ? [status.emoji, status.text].filter(Boolean).join(' ') : '';
  const emergencyCount = state.contacts.filter((c) => c.emergency).length;
  const otherDevices = state.devices.filter((d) => d.deviceId !== state.self.deviceId).length;
  const granted = state.grants.filter((g) => g.placeIds.length && state.contacts.some((c) => c.key === g.contactKey));
  const grantedPlaces = new Set(granted.flatMap((g) => g.placeIds)).size;
  const live = state.liveShares.filter((s) => !s.expiresAt || s.expiresAt > now);

  async function saveName() {
    const clean = name.trim();
    if (!clean) return;
    if (clean === state.self.name) {
      setEditing(false);
      return;
    }
    setSavingName(true);
    try {
      await runtime.setDisplayName(clean);
      setEditing(false);
    } catch (e) {
      notice('Name nicht gespeichert', errorText(e));
    } finally {
      setSavingName(false);
    }
  }

  async function endDemo() {
    const ok = await confirm({
      title: 'Demo beenden?',
      message: 'Alles aus der Demo wird gelöscht, auch Lisa, Max und Oma Ilse. Danach richtest du dein echtes Konto ein.',
      ok: 'Demo beenden',
      destructive: true,
    });
    if (!ok) return;
    setEnding(true);
    try {
      // Back to the welcome screen: name, permissions, or linking an existing account.
      runtime.updateSettings({ onboarded: false });
      await runtime.setDemo(false);
      await restart();
    } catch (e) {
      notice('Demo konnte nicht beendet werden', errorText(e));
      setEnding(false);
    }
  }

  async function setGhost(v: boolean) {
    try {
      await runtime.node.setGhost(v);
    } catch (e) {
      notice('Das hat nicht geklappt', errorText(e));
    }
  }

  return (
    <Screen title="Ich">
      <Narrow>
        {isDemo && (
          <Card style={{ borderColor: t.accent, borderWidth: 1, gap: spacing.sm }}>
            <Row gap={spacing.sm}>
              <Text style={{ fontSize: 22 }} accessible={false}>
                🎮
              </Text>
              <T variant="h2" style={{ flex: 1 }}>
                Demo-Modus
              </T>
            </Row>
            <T variant="muted">Lisa, Max und Oma Ilse sind simuliert. Nichts verlässt dein Gerät, dein echter Standort wird nicht benutzt.</T>
            {isBrowserPreview ? (
              <T variant="small">In der Web-Vorschau läuft immer die Demo. Lade die Seite neu, um von vorn zu beginnen.</T>
            ) : (
              <Button title="Demo beenden" kind="secondary" compact onPress={() => void endDemo()} busy={ending} />
            )}
          </Card>
        )}

        <Card style={{ gap: spacing.md }}>
          <Row gap={spacing.md}>
            <Avatar name={state.self.name} keyHex={state.self.key} size={64} />
            <View style={{ flex: 1, gap: 2 }}>
              <T variant="big" numberOfLines={2}>
                {state.self.name}
              </T>
              <T variant="small">{state.contacts.length === 1 ? '1 Freund' : `${state.contacts.length} Freunde`} · So sehen dich deine Freunde.</T>
            </View>
            {!editing && (
              <Pressable
                onPress={() => {
                  setName(state.self.name);
                  setEditing(true);
                }}
                accessibilityRole="button"
                accessibilityLabel="Namen ändern"
                style={{ minHeight: TOUCH, minWidth: TOUCH, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ fontSize: 20 }}>✏️</Text>
              </Pressable>
            )}
          </Row>
          {editing && (
            <View style={{ gap: spacing.sm }}>
              <Field label="Dein Name" value={name} onChangeText={setName} maxLength={NAME_MAX} autoCapitalize="words" autoFocus counter onSubmitEditing={() => void saveName()} />
              <T variant="small">Deine Freunde sehen den neuen Namen, sobald sie online sind. Wie du sie nennst, bleibt bei dir.</T>
              <Row>
                <Button title="Speichern" compact onPress={() => void saveName()} busy={savingName} disabled={!name.trim()} style={{ flex: 1 }} />
                <Button title="Abbrechen" kind="secondary" compact onPress={() => setEditing(false)} style={{ flex: 1 }} />
              </Row>
            </View>
          )}
          <Pressable
            onPress={() => router.push('/status')}
            accessibilityRole="button"
            accessibilityLabel={status ? `Mein Status: ${statusText}, bis ${hhmm(status.expiresAt)}. Ändern` : 'Status setzen'}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
              minHeight: TOUCH,
              borderRadius: 999,
              paddingHorizontal: spacing.md,
              backgroundColor: pressed ? t.border : t.surfaceRaised,
            })}
          >
            <T style={{ flex: 1 }} color={status ? t.text : t.textMuted} numberOfLines={1}>
              {status ? statusText : '💬 Status setzen, z. B. „🎬 Im Kino“'}
            </T>
            {status ? <T variant="small">{`bis ${hhmm(status.expiresAt)}`}</T> : null}
            <Text style={{ color: t.textMuted, fontSize: 20 }} accessible={false}>
              ›
            </Text>
          </Pressable>
        </Card>

        <Card>
          <Toggle
            label={state.ghost ? '👻 Geistmodus ist an' : '👻 Geistmodus'}
            detail="Pausiert alles automatische Teilen auf einmal: Ankunftszeiten, Orte, Live-Standort. Ein Notruf geht trotzdem raus."
            value={state.ghost}
            onChange={(v) => void setGhost(v)}
          />
        </Card>

        <Section title="Für dich">
          <MenuGroup>
            <MenuRow first icon="💬" title="Mein Status" detail={status ? `${statusText} · bis ${hhmm(status.expiresAt)}` : 'Kein Status gesetzt'} onPress={() => router.push('/status')} />
            <MenuRow
              icon="🌙"
              title="Ruhe & Benachrichtigungen"
              detail={dndActive ? (dndEndsAt ? `Ruhe an bis ${hhmm(dndEndsAt)}` : 'Ruhe ist an') : 'Wer dich wann erreicht'}
              tone={dndActive ? 'warn' : undefined}
              onPress={() => router.push('/quiet')}
            />
            <MenuRow
              icon="🆘"
              title="Notfall-Einstellungen"
              detail={emergencyCount ? `${people(emergencyCount)} bekommen deinen Notruf` : 'Noch keine Notfallkontakte'}
              tone={emergencyCount ? undefined : 'warn'}
              onPress={() => router.push('/safety')}
            />
          </MenuGroup>
        </Section>

        <Section title="Orte & Geräte">
          <MenuGroup>
            <MenuRow
              first
              icon="📍"
              title="Meine Orte"
              detail={state.places.length ? `${state.places.length} ${state.places.length === 1 ? 'Ort' : 'Orte'} · Ankunft und Abfahrt` : 'Zuhause, Arbeit … für „ist angekommen“'}
              onPress={() => router.push('/places')}
            />
            <MenuRow
              icon="📱"
              title="Meine Geräte"
              detail={otherDevices ? `Dieses und ${otherDevices} weitere${otherDevices === 1 ? 's' : ''}` : 'Nur dieses Gerät'}
              onPress={() => router.push('/devices')}
            />
            <MenuRow icon="💾" title="Sicherung" detail="Verschlüsselte Datei für ein neues Handy" onPress={() => router.push('/backup')} />
          </MenuGroup>
        </Section>

        <Section title="App">
          <MenuGroup>
            <MenuRow first icon="➕" title="Freund hinzufügen" detail="QR-Code zeigen oder scannen" onPress={() => router.push('/pair')} />
            <MenuRow icon="⚙️" title="Einstellungen" detail="Aussehen, Karte, Gerät, Über Heyda." onPress={() => router.push('/settings')} />
          </MenuGroup>
        </Section>

        <Section title="Was deine Freunde sehen">
          <Card style={{ gap: spacing.md }}>
            {state.ghost && (
              <Banner tone="warn" icon="👻" title="Geistmodus ist an">
                Gerade geht nichts automatisch raus. Ein Notruf geht trotzdem raus.
              </Banner>
            )}
            <Bullet icon="🕐">Wann du ankommst, nur wenn du eine Fahrt teilst. Gerundet, z. B. „ca. 10 min“.</Bullet>
            <Bullet icon="📍">
              {`„Ist angekommen“ oder „ist losgegangen“, nur an Orten, die du freigibst. ${
                granted.length ? `Gerade: ${people(granted.length)} bei ${grantedPlaces === 1 ? '1 Ort' : `${grantedPlaces} Orten`}.` : 'Gerade für niemanden.'
              }`}
            </Bullet>
            <Bullet icon="🛰️">
              {live.length
                ? `Live-Standort: Du teilst gerade mit ${live.map((s) => `${contactName(s.contactKey)} (${s.level === 'precise' ? 'genau' : 'ungefähr, ~2 km'})`).join(', ')}.`
                : 'Live-Standort nur, wenn du ihn startest. Standard ist ungefähr (~2 km), nie die Straße.'}
            </Bullet>
            <Bullet icon="💬">Deinen Status und ob du gerade Ruhe willst.</Bullet>
            <Bullet icon="🚫">Nie deinen genauen Standort, außer du teilst ihn ausdrücklich genau oder sendest einen Notruf.</Bullet>
            {live.length ? (
              <View style={{ alignSelf: 'flex-start' }}>
                <Pill text={`${live.length} Live-Freigabe${live.length === 1 ? '' : 'n'} aktiv`} color={t.accent} />
              </View>
            ) : null}
          </Card>
        </Section>
      </Narrow>
    </Screen>
  );
}
