import { checkinText, contactLabel, type Contact, type ContactStatus } from '@heyda/core';
import { router, type Href } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { ActivityRow } from '../../components/social/ActivityRow';
import { joinNames, sortContacts } from '../../components/social/contacts';
import { arrivalAt, levelWords, placeEventText, quietText, statusText, watchText } from '../../components/social/describe';
import { ago, errorText, etaWords, hhmm, inTime, remaining } from '../../components/social/format';
import { Banner, ListCard, ListRow, Narrow } from '../../components/social/kit';
import { ThreadAvatar } from '../../components/social/ThreadAvatar';
import { SosButton } from '../../components/SosButton';
import { Avatar, Button, Card, Empty, Row, Screen, Section, T, Toggle } from '../../components/ui';
import { confirm, notice } from '../../lib/confirm';
import { routeForAlert } from '../../lib/routes';
import { useRuntime, useSnapshot } from '../../lib/store';
import { useNow } from '../../components/social/useNow';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';

function greeting(now: number): string {
  const h = new Date(now).getHours();
  if (h < 5) return 'Gute Nacht';
  if (h < 11) return 'Guten Morgen';
  if (h < 17) return 'Hallo';
  if (h < 22) return 'Guten Abend';
  return 'Gute Nacht';
}

const contactHref = (key: string): Href => ({ pathname: '/contact/[key]', params: { key } });

const ACTIONS: { icon: string; label: string; href: Href }[] = [
  { icon: '🚗', label: 'Ankunftszeit teilen', href: '/trip' },
  { icon: '📡', label: 'Live-Standort', href: '/live' },
  { icon: '✅', label: 'Kurz melden', href: '/checkin' },
  { icon: '🛡️', label: 'Pass auf mich auf', href: '/watch' },
  { icon: '🌙', label: 'Ruhe', href: '/quiet' },
  { icon: '🤝', label: 'Freund hinzufügen', href: '/pair' },
];

export default function Start() {
  const t = useTheme();
  const runtime = useRuntime();
  const snap = useSnapshot();
  const { state, statuses, activeTrip, isDemo, activity } = snap;
  const now = useNow(15_000);
  const nameOf = (key: string) => contactLabel(state.contacts.find((c) => c.key === key));
  const contacts = sortContacts(state.contacts);
  const st = (key: string): ContactStatus => statuses[key] ?? {};

  // Things that need attention come first.
  const sosFrom = contacts.filter((c) => st(c.key).sos && !st(c.key).sos?.endedAt);
  const overdue = contacts.flatMap((c) =>
    (st(c.key).watches ?? []).filter((w) => now >= w.dueAt).map((w) => ({ contact: c, watch: w })),
  );
  const questions = [...state.whereInbox]
    .sort((a, b) => b.at - a.at)
    .filter((w, i, all) => all.findIndex((x) => x.from === w.from) === i && state.contacts.some((c) => c.key === w.from));
  const travelling = contacts.filter((c) => st(c.key).trip);
  const liveShares = state.liveShares.filter((s) => !s.expiresAt || s.expiresAt > now);
  const anyActive = !!activeTrip || liveShares.length > 0 || state.watches.length > 0;

  const myStatus = statusText(state.status, now);
  const quiet = snap.dndActive
    ? snap.dndEndsAt !== undefined
      ? `Ruhe ist an, bis ${snap.dndEndsAt - now < 12 * 3600_000 ? hhmm(snap.dndEndsAt) : inTime(snap.dndEndsAt, now)}`
      : 'Ruhe ist an, bis du sie ausschaltest'
    : 'Ruhe ist aus';

  async function toggleGhost(on: boolean) {
    if (on && (liveShares.length || activeTrip)) {
      const ends = [
        liveShares.length ? 'deine Live-Standorte' : '',
        activeTrip ? `das Teilen deiner Ankunftszeit („${activeTrip.destinationName}“)` : '',
      ].filter(Boolean);
      const tripWatch = activeTrip ? state.watches.find((w) => w.tripId === activeTrip.id) : undefined;
      const ok = await confirm({
        title: 'Geistmodus einschalten?',
        message:
          `Dabei ${liveShares.length ? 'werden' : 'wird'} ${ends.join(' und ')} beendet.` +
          (tripWatch ? ` „Pass auf mich auf“ läuft weiter: Melde dich bis ${hhmm(tripWatch.dueAt)} mit „Gut angekommen“.` : ''),
        ok: 'Einschalten',
      });
      if (!ok) return;
    }
    try {
      await runtime.node.setGhost(on);
    } catch (e) {
      notice('Hat nicht geklappt', errorText(e));
    }
  }

  async function stopTrip() {
    try {
      await runtime.node.stopTrip();
    } catch (e) {
      notice('Hat nicht geklappt', errorText(e));
    }
  }

  async function stopLive(key: string) {
    try {
      await runtime.node.stopLive(key);
    } catch (e) {
      notice('Hat nicht geklappt', errorText(e));
    }
  }

  const tripEta = activeTrip ? runtime.node.activeTripEta : undefined;

  return (
    <Screen>
      <Narrow>
        <Row style={{ justifyContent: 'space-between', marginTop: spacing.sm }} gap={spacing.md}>
          <T variant="title" style={{ flex: 1 }}>
            {`${greeting(now)}, ${state.self.name}`}
          </T>
          <SosButton compact />
        </Row>

        {state.sos ? (
          <Banner
            strong
            icon="🆘"
            color={t.danger}
            title="Dein Notruf läuft"
            text={
              state.sos.acks.length
                ? `${joinNames(state.sos.acks.map((a) => nameOf(a.key)))} kümmert sich.`
                : `Gesendet an ${joinNames(state.sos.recipients.map(nameOf))}.`
            }
            action="Öffnen"
            onPress={() => router.push('/sos')}
          />
        ) : null}

        {sosFrom.map((c) => (
          <Banner
            key={`sos-${c.key}`}
            strong
            icon="🆘"
            color={t.danger}
            title={`${contactLabel(c)} braucht Hilfe!`}
            text={st(c.key).sos?.text ?? 'Tippe hier, um zu sehen, wo und wie du helfen kannst.'}
            action="Helfen"
            onPress={() => router.push({ pathname: '/sos-alert/[key]', params: { key: c.key } })}
          />
        ))}

        {overdue.map(({ contact, watch }) => (
          <Banner
            key={`watch-${contact.key}-${watch.watchId}`}
            icon="⏰"
            color={t.danger}
            title={`${contactLabel(contact)} hat sich nicht gemeldet`}
            text={`„${watch.label}“ war bis ${hhmm(watch.dueAt)} geplant. Frag nach, ob alles okay ist.`}
            action="Ansehen"
            onPress={() => router.push(contactHref(contact.key))}
          />
        ))}

        <ListCard>
          <ListRow first onPress={() => router.push('/status')} label={`Mein Status: ${myStatus ?? 'keiner'}. Ändern`}>
            <Row gap={spacing.md}>
              <Text style={{ fontSize: 20 }} accessible={false}>
                💭
              </Text>
              <View style={{ flex: 1 }}>
                <T numberOfLines={1}>{myStatus ?? 'Status setzen …'}</T>
                <T variant="small">
                  {myStatus && state.status
                    ? `Sehen alle deine Kontakte · ${remaining(state.status.expiresAt, now)}`
                    : 'z. B. „🎬 Im Kino“ – sehen alle deine Kontakte'}
                </T>
              </View>
              <T color={t.textMuted}>›</T>
            </Row>
          </ListRow>
          <ListRow onPress={() => router.push('/quiet')} label={`${quiet}. Einstellungen öffnen`}>
            <Row gap={spacing.md}>
              <Text style={{ fontSize: 20 }} accessible={false}>
                {snap.dndActive ? '🌙' : '🔔'}
              </Text>
              <View style={{ flex: 1 }}>
                <T color={snap.dndActive ? t.info : undefined}>{quiet}</T>
                <T variant="small">{snap.dndActive ? 'Nur Wichtiges klingelt. Ein SOS immer.' : 'Benachrichtigungen kommen normal.'}</T>
              </View>
              <T color={t.textMuted}>›</T>
            </Row>
          </ListRow>
          <ListRow>
            <Toggle
              label={state.ghost ? '👻 Geistmodus ist an' : '👻 Geistmodus'}
              detail="Pausiert alles automatische Teilen (Ankunft, Ankunftszeit, Live). SOS funktioniert trotzdem."
              value={state.ghost}
              onChange={(v) => void toggleGhost(v)}
            />
          </ListRow>
        </ListCard>

        {isDemo ? (
          <Card style={{ borderColor: t.info }}>
            <T variant="small" color={t.info}>
              🧪 Demo-Modus: Lisa, Max und Oma Ilse sind simuliert. Nichts verlässt dieses Gerät, dein echter Standort wird nie benutzt.
            </T>
          </Card>
        ) : null}

        {questions.map((q) => (
          <Banner
            key={`where-${q.from}`}
            icon="📍"
            color={t.accent}
            title={`${nameOf(q.from)} fragt: Wo bist du?`}
            text={`${ago(q.at, now)} · Du entscheidest, was du teilst.`}
            action="Antworten"
            onPress={() => router.push({ pathname: '/where/[key]', params: { key: q.from, request: q.requestId } })}
          />
        ))}

        {anyActive ? (
          <Section title="Jetzt aktiv">
            <ListCard>
              {activeTrip ? (
                <ActiveRow
                  first
                  icon="🚗"
                  title={`Unterwegs nach „${activeTrip.destinationName}“`}
                  lines={[
                    state.ghost
                      ? 'Pausiert: Im Geistmodus geht keine Ankunftszeit raus.'
                      : activeTrip.destination
                        ? tripEta !== undefined
                          ? `Ankunft ${etaWords(tripEta)}`
                          : 'Ankunftszeit wird berechnet …'
                        : 'Ohne Ankunftszeit: Freunde sehen „unterwegs“.',
                    `Für ${joinNames(activeTrip.recipients.map(nameOf))} · endet spätestens ${hhmm(activeTrip.expiresAt)}`,
                  ]}
                  onPress={() => router.push('/trip')}
                  stopLabel="Beenden"
                  onStop={() => void stopTrip()}
                />
              ) : null}
              {liveShares.map((s, i) => (
                <ActiveRow
                  key={s.shareId}
                  first={!activeTrip && i === 0}
                  icon="📡"
                  title={`Live mit ${nameOf(s.contactKey)}`}
                  lines={[`${levelWords(s.level)} · ${s.expiresAt ? remaining(s.expiresAt, now) : 'bis du es beendest'}`]}
                  onPress={() => router.push('/live')}
                  stopLabel="Beenden"
                  onStop={() => void stopLive(s.contactKey)}
                />
              ))}
              {state.watches.map((w, i) => {
                const late = now >= w.dueAt;
                return (
                  <ActiveRow
                    key={w.watchId}
                    first={!activeTrip && !liveShares.length && i === 0}
                    icon="🛡️"
                    title={`Pass auf mich auf: „${w.label}“`}
                    lines={[
                      late
                        ? `Zeit abgelaufen – ${joinNames(w.recipients.map(nameOf))} wissen Bescheid. Melde dich!`
                        : `Melde dich bis ${hhmm(w.dueAt)} (${inTime(w.dueAt, now)})`,
                    ]}
                    danger={late}
                    onPress={() => router.push('/watch')}
                  />
                );
              })}
            </ListCard>
          </Section>
        ) : null}

        {travelling.length ? (
          <Section title="Unterwegs">
            {travelling.map((c) => (
              <TripCard key={c.key} contact={c} trip={st(c.key).trip!} now={now} />
            ))}
          </Section>
        ) : null}

        <Section title="Schnell">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {ACTIONS.map((a) => (
              <Pressable
                key={a.label}
                onPress={() => router.push(a.href)}
                accessibilityRole="button"
                accessibilityLabel={a.label}
                style={({ pressed }) => ({
                  flexBasis: '30%',
                  flexGrow: 1,
                  minHeight: 84,
                  backgroundColor: pressed ? t.surfaceRaised : t.surface,
                  borderColor: t.border,
                  borderWidth: 1,
                  borderRadius: radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: spacing.sm,
                  gap: spacing.xs,
                })}
              >
                <Text style={{ fontSize: 26 }} accessible={false}>
                  {a.icon}
                </Text>
                <Text style={{ color: t.text, fontSize: 13, fontWeight: '700', textAlign: 'center' }}>{a.label}</Text>
              </Pressable>
            ))}
          </View>
        </Section>

        <Section
          title="Freunde"
          action={contacts.length ? <Button title="+ Hinzufügen" kind="ghost" compact onPress={() => router.push('/pair')} /> : undefined}
        >
          {contacts.length === 0 ? (
            <Empty
              icon="🫶"
              title="Noch niemand hier"
              text="Füge Familie und Freunde hinzu: Einer zeigt seinen QR-Code, der andere scannt ihn. So weißt du sicher, dass es wirklich die Person ist."
              action={<Button title="Freund hinzufügen" icon="🤝" onPress={() => router.push('/pair')} />}
            />
          ) : (
            <ListCard>
              {contacts.map((c, i) => (
                <FriendRow key={c.key} contact={c} status={st(c.key)} now={now} first={i === 0} />
              ))}
            </ListCard>
          )}
        </Section>

        {activity.length ? (
          <Section title="Zuletzt" action={<Button title="Alle anzeigen" kind="ghost" compact onPress={() => router.push('/activity')} />}>
            <ListCard>
              {activity.slice(0, 3).map((a, i) => (
                <ActivityRow key={a.id} alert={a} now={now} first={i === 0} onPress={() => router.push(routeForAlert(a, state.self.key))} />
              ))}
            </ListCard>
          </Section>
        ) : null}
      </Narrow>
    </Screen>
  );
}

function ActiveRow({
  icon,
  title,
  lines,
  onPress,
  stopLabel,
  onStop,
  first,
  danger,
}: {
  icon: string;
  title: string;
  lines: string[];
  onPress: () => void;
  stopLabel?: string;
  onStop?: () => void;
  first?: boolean;
  danger?: boolean;
}) {
  const t = useTheme();
  return (
    <ListRow first={first} style={{ paddingVertical: spacing.sm }}>
      <Row gap={spacing.sm}>
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={[title, ...lines].join('. ')}
          style={({ pressed }) => ({ flex: 1, flexDirection: 'row', gap: spacing.md, minHeight: TOUCH, alignItems: 'center', opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={{ fontSize: 22 }} accessible={false}>
            {icon}
          </Text>
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="h2" style={{ fontSize: 15 }} color={danger ? t.danger : undefined}>
              {title}
            </T>
            {lines.map((l) => (
              <T key={l} variant="small" color={danger ? t.danger : undefined}>
                {l}
              </T>
            ))}
          </View>
        </Pressable>
        {onStop && stopLabel ? <Button title={stopLabel} kind="secondary" compact onPress={onStop} /> : null}
      </Row>
    </ListRow>
  );
}

function TripCard({ contact, trip, now }: { contact: Contact; trip: NonNullable<ContactStatus['trip']>; now: number }) {
  const t = useTheme();
  const name = contactLabel(contact);
  const arrival = arrivalAt(trip);
  return (
    <Card
      onPress={() => router.push(contactHref(contact.key))}
      label={`${name} ist unterwegs nach ${trip.destinationName}. ${etaWords(trip.etaMinutes)}`}
    >
      <Row gap={spacing.md}>
        <Avatar name={name} keyHex={contact.key} />
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="h2" numberOfLines={1}>{`${name} → ${trip.destinationName}`}</T>
          {trip.etaMinutes !== undefined ? (
            <T variant="big" color={t.accent}>
              {etaWords(trip.etaMinutes)}
            </T>
          ) : (
            <T color={t.accent}>unterwegs, noch keine Ankunftszeit</T>
          )}
          <T variant="small">
            {[arrival !== undefined && trip.etaMinutes ? `gegen ${hhmm(arrival)}` : undefined, `aktualisiert ${ago(trip.updatedAt, now)}`]
              .filter(Boolean)
              .join(' · ')}
          </T>
          {trip.level === 'precise' && trip.point ? <T variant="small">📌 Teilt den genauen Standort (Karte)</T> : null}
        </View>
      </Row>
    </Card>
  );
}

function FriendRow({ contact, status, now, first }: { contact: Contact; status: ContactStatus; now: number; first: boolean }) {
  const t = useTheme();
  const name = contactLabel(contact);
  const s = statusText(status.presence?.status, now);
  const q = quietText(status.presence?.dnd, now);
  const live = status.live && (!status.live.expiresAt || status.live.expiresAt > now) ? status.live : undefined;
  const pending = (status.watches ?? []).filter((w) => now < w.dueAt);

  let event: string | undefined;
  if (status.trip) event = `🚗 unterwegs nach „${status.trip.destinationName}“ · ${etaWords(status.trip.etaMinutes)}`;
  else if (status.lastPlace) event = `📍 ${placeEventText(status.lastPlace, now)}`;
  else if (status.lastCheckin) {
    const ci = status.lastCheckin;
    event = `${checkinText(ci.kind, ci.text, ci.placeName)} · ${ago(ci.at, now)}`;
  }

  const headline = [s, q ? `🌙 ${q}` : undefined].filter(Boolean).join(' · ') || undefined;
  const lines = [
    event,
    live ? `📡 Live · ${levelWords(live.level, live.cell?.cellM)}` : undefined,
    pending[0] ? `🛡️ ${watchText(pending[0], now)}` : undefined,
  ].filter((x): x is string => !!x);

  return (
    <ListRow first={first} onPress={() => router.push(contactHref(contact.key))} label={[name, headline, ...lines].filter(Boolean).join('. ')}>
      <Row gap={spacing.md}>
        <ThreadAvatar thread={contact.key} name={name} live={!!live} />
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="h2" numberOfLines={1}>
            {`${contact.favorite ? '⭐ ' : ''}${name}${contact.muted ? ' 🔕' : ''}`}
          </T>
          {headline ? (
            <T variant="muted" numberOfLines={2}>
              {headline}
            </T>
          ) : null}
          {lines.map((l) => (
            <T key={l} variant="small" numberOfLines={2} color={l.startsWith('📡') ? t.success : undefined}>
              {l}
            </T>
          ))}
          {!headline && !lines.length ? <T variant="small">Teilt gerade nichts</T> : null}
        </View>
        <T color={t.textMuted}>›</T>
      </Row>
    </ListRow>
  );
}
