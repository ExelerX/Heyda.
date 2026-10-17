import { contactLabel, type ContactStatus } from '@heyda/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { BigButton, onFilled } from '../../components/safety/BigButton';
import { Call112 } from '../../components/safety/Call112';
import { Field } from '../../components/safety/Field';
import { contactKeyParam } from '../../components/safety/params';
import { ago, hhmm } from '../../components/safety/time';
import { TileMap } from '../../components/TileMap';
import { Avatar, Button, Card, Chip, Empty, Row, Screen, T, Wrap } from '../../components/ui';
import { notice } from '../../lib/confirm';
import { callPhone, openInMaps } from '../../lib/emergency';
import { isNative } from '../../lib/platform';
import { useRuntime, useSnapshot, useTick } from '../../lib/store';
import { radius, spacing, useTheme } from '../../lib/theme';

type Sos = NonNullable<ContactStatus['sos']>;

const QUICK = [
  { icon: '🚗', text: 'Bin unterwegs' },
  { icon: '📞', text: 'Rufe dich an' },
  { icon: '🚑', text: 'Habe 112 gerufen' },
] as const;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An emergency alert from one of my contacts: where they are, who helps, and what I can do. */
export default function SosAlertScreen() {
  const params = useLocalSearchParams<{ key: string }>();
  const key = contactKeyParam(params.key);
  const { state, statuses } = useSnapshot();
  const contact = key ? state.contacts.find((c) => c.key === key) : undefined;
  const sos = key ? statuses[key]?.sos : undefined;

  if (!key || !sos) {
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: 'Notruf' }} />
        <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center' }}>
          <Empty
            icon="🔍"
            title="Kein Notruf gefunden"
            text={
              contact
                ? `Von ${contactLabel(contact)} gibt es gerade keinen Notruf. Beendete Notrufe verschwinden nach einem Tag.`
                : 'Diesen Notruf gibt es nicht (mehr).'
            }
            action={
              <View style={{ gap: spacing.sm, alignSelf: 'stretch' }}>
                {contact && (
                  <Button
                    title={`Chat mit ${contactLabel(contact)}`}
                    icon="💬"
                    kind="secondary"
                    onPress={() => router.push({ pathname: '/chat/[key]', params: { key: contact.key } })}
                  />
                )}
                <Button title="Zur Startseite" onPress={() => router.replace('/')} />
              </View>
            }
          />
        </View>
      </Screen>
    );
  }

  return <SosDetails ownerKey={key} sos={sos} />;
}

function SosDetails({ ownerKey, sos }: { ownerKey: string; sos: Sos }) {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, settings } = useSnapshot();
  const now = useTick(15_000);
  const [busy, setBusy] = useState<string>();
  const [custom, setCustom] = useState('');
  const contact = state.contacts.find((c) => c.key === ownerKey);
  const name = contact ? contactLabel(contact) : 'Unbekannt';
  const selfKey = state.self.key;
  const ended = sos.endedAt !== undefined;
  const mine = sos.acks.find((a) => a.key === selfKey);
  const fg = onFilled(t);

  async function ack(text?: string) {
    const id = text ?? '';
    setBusy(id);
    try {
      await runtime.node.ackSos(ownerKey, text);
      setCustom('');
    } catch (e) {
      notice('Nicht gesendet', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  // Everyone else who got the alert, plus helpers we only know from replies.
  const people = [
    ...sos.others.map((o) => ({ key: o.key, name: o.name })),
    ...sos.acks.filter((a) => a.key !== selfKey && !sos.others.some((o) => o.key === a.key)).map((a) => ({ key: a.key, name: a.name })),
  ].map((p) => {
    const c = state.contacts.find((x) => x.key === p.key);
    return { ...p, name: c ? contactLabel(c) : p.name, ack: sos.acks.find((a) => a.key === p.key) };
  });
  people.sort((a, b) => Number(!!b.ack) - Number(!!a.ack));

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: ended ? 'Notruf beendet' : `Notruf von ${name}` }} />
      <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', gap: spacing.lg }}>
        {ended ? (
          <Card style={{ borderColor: sos.endReason === 'safe' ? t.success : t.border, borderWidth: 2, gap: spacing.sm }}>
            <T variant="big" color={sos.endReason === 'safe' ? t.success : t.text}>
              {sos.endReason === 'safe' ? `✅ ${name} ist in Sicherheit` : `${name} hat den Notruf abgebrochen`}
            </T>
            <T variant="muted">
              {sos.endReason === 'safe' ? 'Der Notruf ist beendet.' : 'Es war wohl ein Versehen.'} Beendet um {hhmm(sos.endedAt!)} Uhr (
              {ago(sos.endedAt!, now)}).
            </T>
            <T variant="small">
              Notruf von {hhmm(sos.startedAt)} Uhr{sos.text ? `: „${sos.text}“` : ''}
            </T>
          </Card>
        ) : (
          <View
            accessibilityRole="summary"
            style={{ backgroundColor: t.danger, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.sm }}
          >
            <Row gap={spacing.md}>
              <Avatar name={name} keyHex={ownerKey} size={52} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: fg, fontSize: 26, fontWeight: '900' }}>{name} braucht Hilfe!</Text>
                <Text style={{ color: fg, fontSize: 16, fontWeight: '600', marginTop: 2 }}>
                  {ago(sos.startedAt, now)} · um {hhmm(sos.startedAt)} Uhr
                </Text>
              </View>
            </Row>
            {sos.text ? <Text style={{ color: fg, fontSize: 19, fontWeight: '700' }}>„{sos.text}“</Text> : null}
          </View>
        )}

        <LocationCard sos={sos} name={name} mapEnabled={settings.mapEnabled} now={now} ended={ended} />

        {!ended && (
          <Card style={{ gap: spacing.md }}>
            {mine ? (
              <>
                <T variant="h2" color={t.success}>
                  ✅ Du kümmerst dich · {ago(mine.at, now)}
                </T>
                {mine.text ? <T>Deine Nachricht: „{mine.text}“</T> : null}
                <T variant="small">{name} und die anderen Helfer sehen das. Schick bei Bedarf ein kurzes Update:</T>
              </>
            ) : (
              <>
                <BigButton
                  kind="primary"
                  icon="🙋"
                  title="Ich kümmere mich"
                  subtitle={`${name} und die anderen sehen es sofort`}
                  busy={busy === ''}
                  disabled={busy !== undefined && busy !== ''}
                  onPress={() => void ack()}
                />
                <T variant="small">Oder gleich mit kurzer Nachricht:</T>
              </>
            )}
            <Wrap>
              {QUICK.map((q) => (
                <Chip key={q.text} icon={q.icon} label={q.text} selected={mine?.text === q.text} onPress={() => void ack(q.text)} />
              ))}
            </Wrap>
            <Row style={{ alignItems: 'flex-end' }}>
              <View style={{ flex: 1 }}>
                <Field
                  value={custom}
                  onChangeText={setCustom}
                  placeholder="Eigene Nachricht, z. B. Bin in 10 Min. da"
                  maxLength={140}
                  accessibilityLabel="Eigene Nachricht"
                  returnKeyType="send"
                  onSubmitEditing={() => custom.trim() && void ack(custom.trim())}
                />
              </View>
              <Button
                title="Senden"
                compact
                disabled={!custom.trim() || busy !== undefined}
                busy={busy === custom.trim() && !!custom.trim()}
                onPress={() => void ack(custom.trim())}
              />
            </Row>
          </Card>
        )}

        <View style={{ gap: spacing.md }}>
          {contact?.phone ? (
            isNative ? (
              <BigButton
                kind="secondary"
                icon="📞"
                title={`${name} anrufen`}
                subtitle={contact.phone}
                onPress={() => void callPhone(contact.phone!).catch(() => notice('Anruf nicht möglich', contact.phone))}
              />
            ) : (
              <Card>
                <T variant="h2">📞 {name}</T>
                <Text selectable style={{ color: t.text, fontSize: 18, fontWeight: '600' }}>
                  {contact.phone}
                </Text>
                <T variant="small">Anrufen geht nur vom Handy aus.</T>
              </Card>
            )
          ) : null}
          {!ended && <Call112 subtitle="Wenn es ernst ist oder niemand erreichbar ist" />}
          <BigButton
            kind="secondary"
            icon="💬"
            title="Chat öffnen"
            subtitle={`Schreib ${name}`}
            onPress={() => router.push({ pathname: '/chat/[key]', params: { key: ownerKey } })}
          />
        </View>

        <View style={{ gap: spacing.sm }}>
          <T variant="h2">Auch alarmiert</T>
          {people.length === 0 ? (
            <T variant="muted">Nur du hast diesen Notruf bekommen.</T>
          ) : (
            people.map((p) => (
              <Card key={p.key} style={p.ack ? { borderColor: t.success } : undefined}>
                <Row gap={spacing.md}>
                  <Avatar name={p.name} keyHex={p.key} size={36} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T variant="h2">{p.name}</T>
                    {p.ack ? (
                      <T variant="small" color={t.success}>
                        ✅ kümmert sich · {ago(p.ack.at, now)}
                      </T>
                    ) : (
                      <T variant="small">noch keine Antwort</T>
                    )}
                    {p.ack?.text ? <T>„{p.ack.text}“</T> : null}
                  </View>
                </Row>
              </Card>
            ))
          )}
        </View>
      </View>
    </Screen>
  );
}

function LocationCard({ sos, name, mapEnabled, now, ended }: { sos: Sos; name: string; mapEnabled: boolean; now: number; ended: boolean }) {
  const t = useTheme();
  const p = sos.point;
  if (!p) {
    return (
      <Card>
        <T variant="h2">📍 Standort</T>
        <T variant="muted">
          {ended
            ? 'Es wurde kein Standort mitgeschickt.'
            : `Noch kein Standort. ${name}s Handy kannte ihn beim Senden nicht. Er erscheint hier, sobald er nachkommt.`}
        </T>
      </Card>
    );
  }
  const coords = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  const meta = [
    p.accuracyM ? `Genauigkeit ca. ${Math.round(p.accuracyM)} m` : undefined,
    sos.pointAt ? `gesendet ${ago(sos.pointAt, now)}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card style={{ gap: spacing.md }}>
      <T variant="h2">📍 {ended ? 'Letzter Standort' : 'Genauer Standort'}</T>
      {mapEnabled ? (
        <View style={{ borderRadius: radius.md, overflow: 'hidden' }}>
          {/* Starts at the rough area only (the tile server sees it); + zooms in. */}
          <TileMap height={240} markers={[{ id: 'sos', lat: p.lat, lon: p.lon, label: name, kind: 'sos', accuracyM: p.accuracyM }]} />
        </View>
      ) : null}
      <View style={{ gap: 2 }}>
        <Text selectable style={{ color: t.text, fontSize: mapEnabled ? 16 : 22, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
          {coords}
        </Text>
        {meta ? <T variant="small">{meta}</T> : null}
      </View>
      <Button title="In Karten öffnen" icon="🗺️" kind="secondary" onPress={() => void openInMaps(p.lat, p.lon, name).catch(() => {})} />
      {!mapEnabled && <T variant="small">Tipp: Die Karte in der App kannst du in den Einstellungen einschalten.</T>}
    </Card>
  );
}
