import type { Contact, ContactStatus } from '@social-app/core';
import { router } from 'expo-router';
import { Linking, Platform, View } from 'react-native';
import { Avatar, Button, Card, Chip, Empty, Pill, Row, Screen, Section, T } from '../../components/ui';
import { ago, etaText, LEVEL_TEXT, timeLeft } from '../../lib/format';
import { useRuntime, useSnapshot, useTick } from '../../lib/store';
import { spacing, useTheme } from '../../lib/theme';

export default function Home() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, statuses, activeTrip, isDemo } = useSnapshot();
  const now = useTick();

  // People on the way first, then whoever did something most recently.
  const contacts = [...state.contacts].sort((a, b) => rank(statuses[b.key]) - rank(statuses[a.key]));

  return (
    <Screen
      title={`Hallo ${state.self.name}`}
      right={
        <Chip
          label={state.ghost ? 'Unsichtbar' : 'Sichtbar'}
          icon={state.ghost ? '👻' : '👀'}
          selected={state.ghost}
          onPress={() => runtime.setGhost(!state.ghost)}
        />
      }
    >
      {isDemo && (
        <Card style={{ borderColor: t.info }}>
          <T variant="small" color={t.info}>
            🧪 Demo: Lisa und Max sind simuliert. Nichts verlässt dieses Gerät.
          </T>
        </Card>
      )}
      {state.ghost && (
        <Card>
          <T variant="muted">👻 Geistermodus ist an. Niemand bekommt gerade Ankunftszeiten oder Orte von dir.</T>
        </Card>
      )}

      {activeTrip ? (
        <Card style={{ borderColor: t.accent, borderWidth: 1 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T variant="h2">🚗 Du bist unterwegs</T>
            <Pill text={timeLeft(activeTrip.expiresAt, now)} color={t.accent} />
          </Row>
          <T>
            Nach „{activeTrip.destinationName}“ · mit {activeTrip.recipients.map(nameOf(state.contacts)).join(', ')}
          </T>
          <T variant="small">
            {LEVEL_TEXT[activeTrip.level].title}. Endet automatisch, wenn du ankommst.
          </T>
          <Button title="Teilen beenden" kind="secondary" onPress={() => void runtime.stopTrip()} />
        </Card>
      ) : (
        <Card>
          <T variant="h2">Unterwegs?</T>
          <T variant="muted">Teile deine Ankunftszeit mit ausgewählten Leuten. Dein genauer Ort bleibt bei dir.</T>
          <Button
            title="Ankunftszeit teilen"
            icon="🚗"
            onPress={() => router.push('/trip')}
            disabled={!state.contacts.length}
            style={{ marginTop: spacing.sm }}
          />
        </Card>
      )}

      <Section
        title="Freunde"
        action={<Button title="+ Hinzufügen" kind="ghost" compact onPress={() => router.push('/pair')} />}
      >
        {contacts.length === 0 ? (
          <Empty
            icon="🫶"
            title="Noch niemand hier"
            text="Füge Familie und Freunde hinzu, indem ihr gegenseitig eure QR-Codes scannt. So weiß die App sicher, dass es wirklich die Person ist."
            action={<Button title="Freund hinzufügen" onPress={() => router.push('/pair')} />}
          />
        ) : (
          contacts.map((c) => <FriendCard key={c.key} contact={c} status={statuses[c.key] ?? {}} now={now} />)
        )}
      </Section>
    </Screen>
  );
}

function rank(s: ContactStatus | undefined): number {
  if (s?.trip) return 2e13 + s.trip.updatedAt;
  return s?.lastPlace?.at ?? 0;
}

const nameOf = (contacts: Contact[]) => (key: string) => contacts.find((c) => c.key === key)?.name ?? '?';

function FriendCard({ contact, status, now }: { contact: Contact; status: ContactStatus; now: number }) {
  const t = useTheme();
  const runtime = useRuntime();
  const { trip, lastPlace } = status;
  const where = trip?.point ?? trip?.cell;

  return (
    <Card onPress={() => router.push(`/chat/${contact.key}`)} label={`Chat mit ${contact.name}`}>
      <Row gap={spacing.md}>
        <Avatar name={contact.name} keyHex={contact.key} />
        <View style={{ flex: 1, gap: 2 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T variant="h2" numberOfLines={1} style={{ flexShrink: 1 }}>
              {contact.name}
            </T>
            {trip ? (
              <Pill text="unterwegs" color={t.accent} />
            ) : lastPlace?.kind === 'arrive' && now - lastPlace.at < 3 * 3600_000 ? (
              <Pill text="angekommen" color={t.success} />
            ) : null}
          </Row>
          {trip ? (
            <>
              <T variant="big" color={t.accent}>
                {etaText(trip.etaMinutes)}
              </T>
              <T variant="small">
                nach „{trip.destinationName}“ · aktualisiert {ago(trip.updatedAt, now)}
              </T>
            </>
          ) : lastPlace ? (
            <T variant="muted">
              {lastPlace.kind === 'arrive' ? '📍 Bei' : '👋 Hat'} „{lastPlace.placeName}“{' '}
              {lastPlace.kind === 'arrive' ? 'angekommen' : 'verlassen'} · {ago(lastPlace.at, now)}
            </T>
          ) : (
            <T variant="small">Teilt gerade nichts</T>
          )}
        </View>
      </Row>
      <Row style={{ marginTop: spacing.xs }}>
        <Chip label="Tragen helfen?" icon="🛍️" onPress={() => void runtime.sendPing(contact.key, 'help-carry')} />
        <Chip label="Abholen?" icon="🚗" onPress={() => void runtime.sendPing(contact.key, 'pickup-request')} />
        {where && (
          <Chip
            label={trip?.point ? 'Karte' : 'Bereich'}
            icon="🗺️"
            onPress={() => void openInMaps(where.lat, where.lon, contact.name)}
          />
        )}
      </Row>
    </Card>
  );
}

/** Opens the system maps app only when tapped, so no map tiles load inside this app. */
function openInMaps(lat: number, lon: number, label: string) {
  const q = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const url =
    Platform.OS === 'ios'
      ? `https://maps.apple.com/?ll=${q}&q=${encodeURIComponent(label)}`
      : Platform.OS === 'android'
        ? `geo:${q}?q=${q}(${encodeURIComponent(label)})`
        : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
  return Linking.openURL(url).catch(() => {});
}
