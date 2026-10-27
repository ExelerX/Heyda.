import { contactLabel } from '@heyda/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { TileMap } from '../../components/TileMap';
import { cellSize, coarseWords, whereAnswerText } from '../../components/social/describe';
import { ago, coords, errorText, etaWords } from '../../components/social/format';
import { Field, goBack, Narrow, NotFound } from '../../components/social/kit';
import { LIMITS } from '../../components/social/limits';
import { canLocate, ensureFix, ensureForegroundAccess, NO_GPS_TEXT } from '../../components/social/location';
import { contactKeyParam, idParam, param } from '../../components/social/params';
import { Button, Card, Hint, Row, Screen, Section, T } from '../../components/ui';
import { confirm, notice } from '../../lib/confirm';
import { openInMaps } from '../../lib/emergency';
import { useRuntime, useSnapshot } from '../../lib/store';
import { useNow } from '../../components/social/useNow';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';

type Kind = 'declined' | 'text' | 'place' | 'eta' | 'coarse' | 'precise';
const DAY = 24 * 3600_000;

export default function WhereScreen() {
  const t = useTheme();
  const params = useLocalSearchParams<{ key?: string | string[]; request?: string | string[] }>();
  const key = contactKeyParam(params.key);
  const requested = param(params.request) !== undefined ? idParam(params.request) ?? 'invalid' : undefined;
  const runtime = useRuntime();
  const { state, statuses, settings, isDemo, activeTrip } = useSnapshot();
  const now = useNow(15_000);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<Kind | 'ask'>();
  const [sent, setSent] = useState<string>();

  const contact = key ? state.contacts.find((c) => c.key === key) : undefined;
  if (!contact) {
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: 'Wo bist du?' }} />
        <Narrow>
          <NotFound title="Kontakt nicht gefunden" text="Diese Person ist nicht (mehr) in deinen Kontakten." />
        </Narrow>
      </Screen>
    );
  }

  const c = contact;
  const name = contactLabel(c);
  const fromThem = state.whereInbox.filter((w) => w.from === c.key).sort((a, b) => b.at - a.at);
  const exact = requested ? fromThem.find((w) => w.requestId === requested) : undefined;
  const request = exact ?? fromThem[0];
  const stale = !!requested && !exact && !sent;
  const located = canLocate(isDemo);
  const place = runtime.node.currentPlace();
  const eta = activeTrip ? runtime.node.activeTripEta : undefined;
  const asked = [...state.whereAsked].reverse().find((w) => w.from === c.key && now - w.at < DAY);
  const last = statuses[c.key]?.lastWhere;
  const clean = text.trim();

  async function answer(kind: Kind) {
    if (!request || busy) return;
    if (kind === 'precise') {
      const ok = await confirm({
        title: 'Genauen Standort schicken?',
        message: `${name} sieht dann einmalig, wo du genau bist. Danach wird nichts weiter geteilt.`,
        ok: 'Schicken',
      });
      if (!ok) return;
    }
    setBusy(kind);
    try {
      if (kind === 'coarse' || kind === 'precise') {
        if (!(await ensureForegroundAccess(isDemo))) {
          notice('Standort nicht erlaubt', 'Erlaube Heyda. den Standort in den Einstellungen deines Handys – oder antworte mit einem Text.');
          return;
        }
        if (!(await ensureFix(runtime, 10 * 60_000))) {
          notice('Standort gerade unbekannt', 'Dein Handy findet gerade keinen Standort. Versuch es gleich nochmal oder schick eine Nachricht.');
          return;
        }
      }
      await runtime.node.answerWhere(c.key, request.requestId, { kind, text: clean || undefined });
      setSent(
        {
          declined: 'Du hast geantwortet, dass du es gerade nicht sagen möchtest.',
          text: `Du hast geantwortet: „${clean}“`,
          place: `Du hast geantwortet, dass du bei „${place?.name ?? '…'}“ bist.`,
          eta: 'Du hast deine Ankunftszeit geschickt.',
          coarse: `Du hast deine ungefähre Gegend (${cellSize()}) geschickt.`,
          precise: 'Du hast deinen genauen Standort geschickt.',
        }[kind],
      );
      setText('');
    } catch (e) {
      notice('Nicht gesendet', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function ask() {
    setBusy('ask');
    try {
      await runtime.node.askWhere(c.key);
    } catch (e) {
      notice('Gerade nicht möglich', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  if (request && !sent) {
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: `${name} fragt` }} />
        <Narrow>
          <Card style={{ gap: spacing.xs }}>
            <T variant="big">{`📍 ${name} fragt: Wo bist du?`}</T>
            <T variant="small">{ago(request.at, now)}</T>
            <T variant="muted">{`Du entscheidest, was du teilst. Nur diese eine Antwort geht an ${name} – danach nichts weiter.`}</T>
          </Card>

          <Field
            label="Nachricht dazu (freiwillig)"
            value={text}
            onChangeText={setText}
            maxLength={LIMITS.whereText}
            placeholder="z. B. Bin gleich da!"
            multiline
          />

          <Section title="Deine Antwort">
            <Option
              icon="💬"
              title="Nur die Nachricht schicken"
              detail={clean ? `„${clean}“` : 'Schreib oben etwas, z. B. „Beim Bäcker“.'}
              onPress={() => void answer('text')}
              disabled={!clean}
              busy={busy === 'text'}
            />
            {place ? (
              <Option
                icon="🏠"
                title={`Ich bin bei „${place.name}“`}
                detail="Nur der Name deines Orts, keine Adresse."
                onPress={() => void answer('place')}
                busy={busy === 'place'}
              />
            ) : null}
            {activeTrip ? (
              <Option
                icon="🚗"
                title={
                  eta === undefined
                    ? `Ich bin unterwegs nach „${activeTrip.destinationName}“`
                    : eta <= 0
                      ? 'Ich bin gleich da'
                      : `Ankunft in ${etaWords(eta)}`
                }
                detail={`Unterwegs nach „${activeTrip.destinationName}“. Kein Standort.`}
                onPress={() => void answer('eta')}
                busy={busy === 'eta'}
              />
            ) : null}
            {located ? (
              <>
                <Option
                  icon="🗺️"
                  title={`Ungefähr (${cellSize()})`}
                  detail={`Nur die Gegend: ein Feld von etwa ${cellSize().slice(1)}, nie die Straße.`}
                  onPress={() => void answer('coarse')}
                  busy={busy === 'coarse'}
                />
                <Option
                  icon="📌"
                  title="Genau"
                  detail="Dein genauer Standort, einmalig."
                  onPress={() => void answer('precise')}
                  busy={busy === 'precise'}
                />
              </>
            ) : (
              <Hint>{`${NO_GPS_TEXT} Hier kannst du mit einem Text antworten.`}</Hint>
            )}
            <Option
              icon="🙊"
              title="Lieber nicht"
              detail={`${name} sieht: „möchte gerade nicht sagen, wo“.`}
              onPress={() => void answer('declined')}
              busy={busy === 'declined'}
            />
          </Section>
          {isDemo && located ? <T variant="small">🧪 Demo: Es wird ein ausgedachter Standort benutzt, nie dein echter.</T> : null}
        </Narrow>
      </Screen>
    );
  }

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: `Wo ist ${name}?` }} />
      <Narrow>
        {sent ? (
          <Card style={{ borderColor: t.success, gap: spacing.sm }}>
            <T variant="h2" color={t.success}>
              ✓ Antwort gesendet
            </T>
            <T variant="muted">{sent}</T>
            <Row gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
              <Button title="Zum Chat" icon="💬" kind="secondary" compact onPress={() => router.replace({ pathname: '/chat/[key]', params: { key: c.key } })} />
              <Button title="Fertig" kind="ghost" compact onPress={() => goBack()} />
            </Row>
          </Card>
        ) : null}
        {stale ? <Hint>Diese Frage ist schon beantwortet oder abgelaufen.</Hint> : null}

        <Card style={{ gap: spacing.sm }}>
          <T variant="h2">{`Frag ${name}: Wo bist du?`}</T>
          <T variant="muted">{`${name} entscheidet selbst, was geantwortet wird: gar nichts, ein Text, ein Ort, die Ankunftszeit oder der Standort.`}</T>
          <Button title="Wo bist du? fragen" icon="📍" onPress={() => void ask()} busy={busy === 'ask'} />
          {asked ? <T variant="small">{`⏳ Gefragt ${ago(asked.at, now)} – noch keine Antwort.`}</T> : null}
        </Card>

        <Section title="Letzte Antwort">
          {!last ? (
            <T variant="muted">{`Noch keine Antwort von ${name}.`}</T>
          ) : (
            <Card style={{ gap: spacing.sm }}>
              <T>{whereAnswerText(last)}</T>
              <T variant="small">{ago(last.at, now)}</T>
              {last.answer === 'coarse' && last.cell ? (
                settings.mapEnabled ? (
                  <>
                    <TileMap
                      height={240}
                      markers={[{ id: 'where', lat: last.cell.lat, lon: last.cell.lon, label: `${name} (${coarseWords(last.cell.cellM)})`, kind: 'friend', cellM: last.cell.cellM }]}
                    />
                    <T variant="small">{`Ungefähr: ${name} war irgendwo in diesem Feld (${cellSize(last.cell.cellM)}), nicht unbedingt in der Mitte.`}</T>
                  </>
                ) : (
                  <MapOff label={`Ungefähre Gegend (${cellSize(last.cell.cellM)}). Schalte die Karte ein, um das Feld zu sehen.`} />
                )
              ) : null}
              {last.answer === 'precise' && last.point ? (
                <>
                  {settings.mapEnabled ? (
                    <TileMap
                      height={240}
                      markers={[{ id: 'where', lat: last.point.lat, lon: last.point.lon, label: name, kind: 'friend', accuracyM: last.point.accuracyM }]}
                    />
                  ) : null}
                  <T variant="small">{`📌 ${coords(last.point.lat, last.point.lon)} · auf ca. ${Math.round(last.point.accuracyM)} m genau`}</T>
                  <Button
                    title="In Karten öffnen"
                    icon="🗺️"
                    kind="secondary"
                    compact
                    onPress={() => void openInMaps(last.point!.lat, last.point!.lon, name).catch(() => {})}
                  />
                  {!settings.mapEnabled ? <MapOff label="Oder schalte die Karte in Heyda. ein." /> : null}
                </>
              ) : null}
            </Card>
          )}
        </Section>
      </Narrow>
    </Screen>
  );
}

function MapOff({ label }: { label: string }) {
  return (
    <View style={{ gap: spacing.xs }}>
      <T variant="small">{label}</T>
      <Button title="Zur Karte" kind="ghost" compact onPress={() => router.push('/map')} style={{ alignSelf: 'flex-start' }} />
    </View>
  );
}

function Option({
  icon,
  title,
  detail,
  onPress,
  disabled,
  busy,
}: {
  icon: string;
  title: string;
  detail?: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const t = useTheme();
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${title}. ${detail}` : title}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: pressed ? t.surfaceRaised : t.surface,
        borderWidth: 1,
        borderColor: t.border,
        borderRadius: radius.md,
        padding: spacing.md,
        minHeight: TOUCH + 12,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Text style={{ fontSize: 24 }} accessible={false}>
        {icon}
      </Text>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="h2">{title}</T>
        {detail ? <T variant="small">{detail}</T> : null}
      </View>
      <T color={t.accent}>{busy ? '…' : '›'}</T>
    </Pressable>
  );
}
