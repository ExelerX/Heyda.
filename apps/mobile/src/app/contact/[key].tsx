import { checkinText, contactLabel, PING_KINDS, PING_LABELS, type PingKind } from '@heyda/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import {
  arrivalAt,
  coarseWords,
  levelWords,
  liveText,
  placeEventText,
  quietText,
  statusText,
  tripText,
  watchText,
  whereAnswerText,
} from '../../components/social/describe';
import { ago, errorText, hhmm, remaining } from '../../components/social/format';
import { Banner, Fact, Field, Narrow, NotFound } from '../../components/social/kit';
import { LIMITS } from '../../components/social/limits';
import { contactKeyParam, param } from '../../components/social/params';
import { Avatar, Button, Card, Chip, Hint, Pill, Row, Screen, Section, T, Toggle, Wrap } from '../../components/ui';
import { confirm, notice } from '../../lib/confirm';
import { callPhone, openInMaps } from '../../lib/emergency';
import { isNative } from '../../lib/platform';
import { useRuntime, useSnapshot } from '../../lib/store';
import { useNow } from '../../components/social/useNow';
import { spacing, useTheme } from '../../lib/theme';

const PINGS: PingKind[] = PING_KINDS.filter((k) => k !== 'custom');
const DAY = 24 * 3600_000;
const PHONE = /^\+?\d{3,31}$/;

export default function ContactDetails() {
  const t = useTheme();
  const params = useLocalSearchParams<{ key?: string | string[]; added?: string | string[] }>();
  const key = contactKeyParam(params.key);
  const justAdded = param(params.added) === '1';
  const runtime = useRuntime();
  const { state, statuses, activeTrip } = useSnapshot();
  const now = useNow(15_000);
  const contact = key ? state.contacts.find((c) => c.key === key) : undefined;

  const [nickname, setNickname] = useState(contact?.nickname ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [pings, setPings] = useState(false);
  const [sent, setSent] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [removing, setRemoving] = useState(false);

  useEffect(() => setNickname(contact?.nickname ?? ''), [contact?.nickname]);
  useEffect(() => setPhone(contact?.phone ?? ''), [contact?.phone]);
  useEffect(() => {
    if (!sent) return;
    const id = setTimeout(() => setSent(undefined), 4000);
    return () => clearTimeout(id);
  }, [sent]);

  if (removing) {
    return (
      <Screen edges={['bottom']}>
        <ActivityIndicator color={t.accent} style={{ marginTop: spacing.xxl }} />
      </Screen>
    );
  }

  if (!contact) {
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: 'Kontakt' }} />
        <Narrow>
          <NotFound title="Kontakt nicht gefunden" text="Diese Person ist nicht (mehr) in deinen Kontakten." />
        </Narrow>
      </Screen>
    );
  }

  const c = contact;
  const name = contactLabel(c);
  const s = statuses[c.key] ?? {};
  const sos = s.sos && !s.sos.endedAt ? s.sos : undefined;
  const st = statusText(s.presence?.status, now);
  const quiet = quietText(s.presence?.dnd, now);
  const live = s.live && (!s.live.expiresAt || s.live.expiresAt > now) ? s.live : undefined;
  const asked = [...state.whereAsked].reverse().find((w) => w.from === c.key && now - w.at < DAY);
  const question = [...state.whereInbox].reverse().find((w) => w.from === c.key);
  const granted = state.grants.find((g) => g.contactKey === c.key)?.placeIds ?? [];
  const myLive = state.liveShares.find((l) => l.contactKey === c.key && (!l.expiresAt || l.expiresAt > now));
  const myTrip = activeTrip?.recipients.includes(c.key) ? activeTrip : undefined;
  const myWatches = state.watches.filter((w) => w.recipients.includes(c.key));
  const nothingShared =
    !sos && !st && !quiet && !s.trip && !live && !s.lastPlace && !s.lastWhere && !s.lastCheckin && !(s.watches ?? []).length;

  async function run(what: string, fn: () => Promise<void> | void, failTitle = 'Hat nicht geklappt') {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      notice(failTitle, errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  const sendPing = (kind: PingKind) =>
    run(`ping-${kind}`, async () => {
      await runtime.node.sendPing(c.key, kind);
      setSent(`Gesendet: ${PING_LABELS[kind].emoji} ${PING_LABELS[kind].text}`);
      setPings(false);
    }, 'Nicht gesendet');

  const askWhere = () =>
    run('ask', async () => {
      await runtime.node.askWhere(c.key);
      setSent(`Gefragt: „Wo bist du?“ ${name} entscheidet, was geantwortet wird.`);
    }, 'Gerade nicht möglich');

  const saveNickname = () => {
    runtime.node.updateContact(c.key, { nickname: nickname.trim() || undefined });
    setSent(nickname.trim() ? `Gespeichert: Du siehst jetzt „${nickname.trim()}“.` : `Spitzname entfernt.`);
  };

  const savePhone = () => {
    const clean = phone.replace(/[^\d+]/g, '');
    if (clean && !PHONE.test(clean)) {
      notice('Telefonnummer prüfen', 'Bitte gib eine Nummer wie +49 170 1234567 ein.');
      return;
    }
    runtime.node.updateContact(c.key, { phone: clean || undefined });
    setSent(clean ? 'Telefonnummer gespeichert.' : 'Telefonnummer entfernt.');
  };

  const toggleGrant = (placeId: string) =>
    runtime.setPlaceGrant(c.key, granted.includes(placeId) ? granted.filter((p) => p !== placeId) : [...granted, placeId]);

  async function verify() {
    const ok = await confirm({
      title: 'Sicherheitsnummer verglichen?',
      message: `Bestätige nur, wenn ${name} dir die gleiche Zahl auf dem eigenen Handy gezeigt hat – am besten persönlich.`,
      ok: 'Ja, stimmt überein',
    });
    if (ok) runtime.node.markVerified(c.key);
  }

  async function remove() {
    // The core leaves the groups they made (see `endEverythingWith`).
    const theirGroups = state.groups.filter((g) => g.owner === c.key && !g.dissolved).map((g) => `„${g.name}“`);
    const groupsNote = theirGroups.length
      ? ` Aus ${theirGroups.length === 1 ? 'der Gruppe' : 'den Gruppen'} ${theirGroups.join(', ')}, die ${name} erstellt hat, trittst du aus.`
      : '';
    const ok = await confirm({
      title: `${name} entfernen?`,
      message: `${name} bekommt dann nichts mehr von dir – keine Nachrichten, keine Ankunftszeiten, keinen Standort. Euer Chat wird auf diesem Gerät gelöscht.${groupsNote} Um wieder verbunden zu sein, scannt ihr erneut eure Codes.`,
      ok: 'Entfernen',
      destructive: true,
    });
    if (!ok) return;
    setRemoving(true);
    try {
      await runtime.removeContact(c.key);
      router.dismissTo('/');
    } catch (e) {
      setRemoving(false);
      notice('Hat nicht geklappt', errorText(e));
    }
  }

  const mapButton = (lat: number, lon: number) => (
    <Button title="In Karten öffnen" kind="ghost" compact onPress={() => void openInMaps(lat, lon, name).catch(() => {})} />
  );

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: name }} />
      <Narrow>
        <Row gap={spacing.lg} style={{ marginTop: spacing.sm }}>
          <Avatar name={name} keyHex={c.key} size={64} />
          <View style={{ flex: 1, gap: 4 }}>
            <T variant="big">{`${c.favorite ? '⭐ ' : ''}${name}`}</T>
            {c.nickname ? <T variant="small">{`nennt sich selbst „${c.name}“`}</T> : null}
            <Row gap={spacing.xs} style={{ flexWrap: 'wrap' }}>
              {c.verified ? <Pill text="✓ Verifiziert" color={t.success} /> : <Pill text="Nicht verifiziert" color={t.textMuted} />}
              {c.emergency ? <Pill text="🆘 Notfallkontakt" color={t.danger} /> : null}
              {c.muted ? <Pill text="🔕 Stumm" color={t.textMuted} /> : null}
            </Row>
          </View>
        </Row>

        {justAdded ? (
          <Banner
            icon="🎉"
            color={t.success}
            title={`${name} ist jetzt in deinen Kontakten`}
            text="Vergleicht am besten gleich eure Sicherheitsnummer (weiter unten), wenn ihr nebeneinander steht."
          />
        ) : null}

        {sos ? (
          <Banner
            strong
            icon="🆘"
            color={t.danger}
            title={`${name} braucht Hilfe!`}
            text={sos.text ?? 'Tippe hier, um zu sehen, wo und wie du helfen kannst.'}
            action="Helfen"
            onPress={() => router.push({ pathname: '/sos-alert/[key]', params: { key: c.key } })}
          />
        ) : null}
        {question ? (
          <Banner
            icon="📍"
            color={t.accent}
            title={`${name} fragt: Wo bist du?`}
            text={`${ago(question.at, now)} · Du entscheidest, was du teilst.`}
            action="Antworten"
            onPress={() => router.push({ pathname: '/where/[key]', params: { key: c.key, request: question.requestId } })}
          />
        ) : null}

        <Wrap>
          <Button title="Chat" icon="💬" compact onPress={() => router.push({ pathname: '/chat/[key]', params: { key: c.key } })} />
          <Button title="Ping" icon="👋" kind="secondary" compact onPress={() => setPings((p) => !p)} />
          <Button title="Wo bist du?" icon="📍" kind="secondary" compact busy={busy === 'ask'} onPress={() => void askWhere()} />
          <Button
            title="Ankunftszeit teilen"
            icon="🚗"
            kind="secondary"
            compact
            onPress={() => router.push({ pathname: '/trip', params: { to: c.key } })}
          />
          <Button title="Live teilen" icon="📡" kind="secondary" compact onPress={() => router.push({ pathname: '/live', params: { to: c.key } })} />
          {c.phone ? <Button title="Anrufen" icon="📞" kind="secondary" compact onPress={() => void callPhone(c.phone!).catch(() => {})} /> : null}
        </Wrap>
        {pings ? (
          <Card>
            <T variant="small">{`Kurze Nachricht an ${name}, mit einem Tipp:`}</T>
            <Wrap>
              {PINGS.map((k) => (
                <Chip key={k} label={PING_LABELS[k].text} icon={PING_LABELS[k].emoji} onPress={() => void sendPing(k)} />
              ))}
            </Wrap>
          </Card>
        ) : null}
        {sent ? (
          <T variant="small" color={t.success} style={{ marginTop: -spacing.xs }}>
            {`✓ ${sent}`}
          </T>
        ) : null}

        <Section title={`Was ${name} gerade teilt`}>
          <Card style={{ gap: spacing.md }}>
            {st ? (
              <Fact icon="💭">
                <T>{st}</T>
                {s.presence?.status ? <T variant="small">{remaining(s.presence.status.expiresAt, now)}</T> : null}
              </Fact>
            ) : null}
            {quiet ? <Fact icon="🌙">{quiet}</Fact> : null}
            {s.trip ? (
              <Fact icon="🚗" right={s.trip.point ? mapButton(s.trip.point.lat, s.trip.point.lon) : undefined}>
                <T>{tripText(s.trip, now)}</T>
                <T variant="small">
                  {[
                    arrivalAt(s.trip) !== undefined && s.trip.etaMinutes ? `gegen ${hhmm(arrivalAt(s.trip)!)}` : undefined,
                    s.trip.point ? 'genauer Standort' : s.trip.cell ? coarseWords(s.trip.cell.cellM) : undefined,
                    `aktualisiert ${ago(s.trip.updatedAt, now)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </T>
              </Fact>
            ) : null}
            {live ? (
              <Fact icon="📡" right={live.point ? mapButton(live.point.lat, live.point.lon) : undefined}>
                <T color={t.success}>{liveText(live, now)}</T>
                {live.cell || live.point ? (
                  <Button title="Auf der Karte zeigen" kind="ghost" compact onPress={() => router.push('/map')} style={{ alignSelf: 'flex-start', paddingHorizontal: 0 }} />
                ) : null}
              </Fact>
            ) : null}
            {s.lastPlace ? <Fact icon="📍">{placeEventText(s.lastPlace, now)}</Fact> : null}
            {s.lastCheckin ? (
              <Fact icon="✅">
                <T>{checkinText(s.lastCheckin.kind, s.lastCheckin.text, s.lastCheckin.placeName).replace(/^\S+\s/, '')}</T>
                <T variant="small">{`hat sich gemeldet · ${ago(s.lastCheckin.at, now)}`}</T>
              </Fact>
            ) : null}
            {(s.watches ?? []).map((w) => (
              <Fact key={w.watchId} icon={now >= w.dueAt ? '⏰' : '🛡️'} color={now >= w.dueAt ? t.danger : undefined}>
                {`Pass auf mich auf: ${watchText(w, now)}`}
              </Fact>
            ))}
            {s.lastWhere ? (
              <Fact
                icon="🧭"
                right={
                  <Button
                    title="Ansehen"
                    kind="ghost"
                    compact
                    onPress={() => router.push({ pathname: '/where/[key]', params: { key: c.key } })}
                  />
                }
              >
                <T>{whereAnswerText(s.lastWhere)}</T>
                <T variant="small">{`Antwort auf „Wo bist du?“ · ${ago(s.lastWhere.at, now)}`}</T>
              </Fact>
            ) : null}
            {asked ? <Fact icon="⏳">{`Du hast ${ago(asked.at, now)} gefragt, wo ${name} ist. Noch keine Antwort.`}</Fact> : null}
            {nothingShared ? (
              <T variant="muted">{`${name} teilt gerade nichts mit dir. Das ist normal: Heyda. teilt nur, wenn jemand es will.`}</T>
            ) : null}
          </Card>
        </Section>

        <Section title={`Was ${name} von dir erfährt`}>
          <Card style={{ gap: spacing.md }}>
            {myTrip ? (
              <Fact icon="🚗">{`Deine Ankunftszeit nach „${myTrip.destinationName}“ (bis spätestens ${hhmm(myTrip.expiresAt)})`}</Fact>
            ) : null}
            {myLive ? (
              <Fact
                icon="📡"
                right={
                  <Button
                    title="Beenden"
                    kind="secondary"
                    compact
                    busy={busy === 'stoplive'}
                    onPress={() => void run('stoplive', () => runtime.node.stopLive(c.key))}
                  />
                }
              >
                {`Dein Live-Standort, ${levelWords(myLive.level)} · ${myLive.expiresAt ? remaining(myLive.expiresAt, now) : 'bis du es beendest'}`}
              </Fact>
            ) : null}
            {myWatches.map((w) => (
              <Fact key={w.watchId} icon="🛡️">{`Pass auf mich auf: „${w.label}“ bis ${hhmm(w.dueAt)}`}</Fact>
            ))}
            {c.emergency ? <Fact icon="🆘">Bekommt deinen Notruf mit genauem Standort.</Fact> : null}
            <View style={{ gap: spacing.sm }}>
              <T variant="h2" style={{ fontSize: 15 }}>
                Ankommen und Losgehen
              </T>
              <T variant="small">
                {`${name} bekommt automatisch Bescheid, wenn du an diesen Orten ankommst oder sie verlässt. Nur der Name des Orts geht raus, nie die Adresse.`}
              </T>
              {state.places.length ? (
                <Wrap>
                  {state.places.map((p) => (
                    <Chip key={p.id} label={p.name} icon={granted.includes(p.id) ? '✓' : '📍'} selected={granted.includes(p.id)} onPress={() => toggleGrant(p.id)} />
                  ))}
                </Wrap>
              ) : (
                <Button title="Orte anlegen" icon="📍" kind="secondary" compact onPress={() => router.push('/places')} style={{ alignSelf: 'flex-start' }} />
              )}
              {state.ghost ? <T variant="small" color={t.info}>👻 Der Geistmodus ist an: Gerade geht nichts davon raus.</T> : null}
            </View>
          </Card>
        </Section>

        <Section title="Deine Einstellungen">
          <Card style={{ gap: spacing.md }}>
            <Field
              label="Spitzname (nur für dich)"
              value={nickname}
              onChangeText={setNickname}
              maxLength={LIMITS.nickname}
              placeholder={c.name}
              returnKeyType="done"
              onSubmitEditing={saveNickname}
            />
            {nickname.trim() !== (c.nickname ?? '') ? (
              <Button title="Spitznamen speichern" compact onPress={saveNickname} />
            ) : null}
            <Toggle
              label="⭐ Favorit"
              detail="Steht oben in der Liste und kommt bei „Bitte nicht stören“ durch, wenn du das erlaubst."
              value={!!c.favorite}
              onChange={(v) => runtime.node.updateContact(c.key, { favorite: v })}
            />
            <Toggle
              label="🔕 Stumm"
              detail="Keine Benachrichtigungen von dieser Person. Ein Notruf klingelt trotzdem."
              value={!!c.muted}
              onChange={(v) => runtime.node.updateContact(c.key, { muted: v })}
            />
            <Toggle
              label="🆘 Notfallkontakt"
              detail="Bekommt deinen Notruf (SOS) mit genauem Standort – auch im Geistmodus."
              value={!!c.emergency}
              onChange={(v) => runtime.node.updateContact(c.key, { emergency: v })}
            />
            <Field
              label="Telefonnummer (für SMS im Notfall)"
              value={phone}
              onChangeText={setPhone}
              maxLength={LIMITS.phone}
              placeholder="+49 170 1234567"
              keyboardType="phone-pad"
              autoComplete="tel"
              returnKeyType="done"
              onSubmitEditing={savePhone}
              hint="Bleibt auf deinen Geräten. Wird nur für die Notruf-SMS und „Anrufen“ benutzt."
            />
            {phone.replace(/[^\d+]/g, '') !== (c.phone ?? '') ? (
              <Button title="Telefonnummer speichern" compact onPress={savePhone} />
            ) : null}
            {c.emergency && !c.phone && isNative ? (
              <Hint>Mit Telefonnummer kann dein Notruf auch per SMS rausgehen, falls das Internet fehlt.</Hint>
            ) : null}
          </Card>
        </Section>

        <Section title="Sicherheitsnummer">
          <Card style={{ alignItems: 'center', gap: spacing.md }}>
            <Text
              selectable
              accessibilityLabel={`Sicherheitsnummer ${runtime.safetyNumberWith(c.key).split('').join(' ')}`}
              style={{
                color: t.text,
                fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                fontSize: 20,
                letterSpacing: 2,
                textAlign: 'center',
                lineHeight: 30,
              }}
            >
              {runtime.safetyNumberWith(c.key)}
            </Text>
            {c.verified ? (
              <Pill text="✓ Verifiziert" color={t.success} />
            ) : (
              <Button title="Als verifiziert markieren" icon="✅" kind="secondary" compact onPress={() => void verify()} />
            )}
          </Card>
          <T variant="small">
            {`Vergleicht diese Zahl persönlich auf beiden Handys. Ist sie gleich, hat sich niemand zwischen dich und ${name} geschaltet.`}
          </T>
        </Section>

        <Section title="Kontakt entfernen">
          <Button title={`${name} entfernen`} kind="danger" onPress={() => void remove()} />
        </Section>
      </Narrow>
    </Screen>
  );
}
