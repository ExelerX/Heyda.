import { bucketEtaMinutes, contactLabel, EtaEstimator, parseLocationInput, type LatLon, type SessionLevel } from '@heyda/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { ContactPicker } from '../components/social/ContactPicker';
import { joinNames } from '../components/social/contacts';
import { coords, durationWords, errorText, etaWords, hhmm, inTime } from '../components/social/format';
import { Choice, Field, goBack, Narrow } from '../components/social/kit';
import { LIMITS } from '../components/social/limits';
import { canLocate, ensureFix, ensureTrackingAccess, NO_GPS_TEXT } from '../components/social/location';
import { contactKeyParam } from '../components/social/params';
import { Button, Card, Chip, Empty, Hint, Row, Screen, Section, T, Toggle, Wrap } from '../components/ui';
import { confirm, notice } from '../lib/confirm';
import { currentLocationAccess, locationSupported, type LocationAccess } from '../lib/location';
import { useRuntime, useSnapshot } from '../lib/store';
import { useNow } from '../components/social/useNow';
import { spacing, useTheme } from '../lib/theme';

const MIN = 60_000;
const DURATIONS = [30, 60, 120, 240, 480, 1440].map((m) => m * MIN);
const DEFAULT_DURATION = 120 * MIN;
const MIN_WATCH = 5 * MIN;
const MAX_WATCH = 48 * 60 * MIN;
const LINK = '__link__';
const NAME = '__name__';

export default function TripScreen() {
  const { activeTrip } = useSnapshot();
  const [editing, setEditing] = useState(false);
  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: activeTrip && !editing ? 'Du bist unterwegs' : 'Ankunftszeit teilen' }} />
      <Narrow>
        {activeTrip && !editing ? <ActiveTrip onNew={() => setEditing(true)} /> : <TripForm onStarted={() => setEditing(false)} />}
      </Narrow>
    </Screen>
  );
}

function ActiveTrip({ onNew }: { onNew: () => void }) {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, activeTrip, isDemo } = useSnapshot();
  const now = useNow(5000);
  const [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<LocationAccess | undefined>();

  useEffect(() => {
    if (!isDemo && locationSupported) void currentLocationAccess().then(setAccess).catch(() => {});
  }, [isDemo]);

  if (!activeTrip) return null;
  const trip = activeTrip;
  const eta = runtime.node.activeTripEta;
  const names = trip.recipients.map((k) => contactLabel(state.contacts.find((c) => c.key === k)));
  const watch = state.watches.find((w) => w.tripId === trip.id);
  const noGps = !canLocate(isDemo);

  async function stop() {
    if (watch) {
      const ok = await confirm({
        title: 'Teilen beenden?',
        message: `„Pass auf mich auf“ läuft weiter: Melde dich bis ${hhmm(watch.dueAt)} mit „Gut angekommen“, sonst gibt es Alarm.`,
        ok: 'Beenden',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await runtime.node.stopTrip();
      goBack();
    } catch (e) {
      notice('Hat nicht geklappt', errorText(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Card style={{ borderColor: t.accent, borderWidth: 1.5, gap: spacing.sm }}>
        <T variant="h2">{`🚗 Unterwegs nach „${trip.destinationName}“`}</T>
        {state.ghost ? (
          <T color={t.info}>👻 Geistmodus ist an: Gerade geht keine Ankunftszeit raus. Schalte ihn aus, damit deine Freunde sie sehen.</T>
        ) : trip.destination ? (
          eta !== undefined ? (
            <>
              <T variant="title" color={t.accent}>
                {etaWords(eta)}
              </T>
              {eta > 0 ? <T variant="small">{`Ankunft gegen ${hhmm(now + eta * MIN)} · so sehen es deine Freunde (gerundet)`}</T> : null}
            </>
          ) : (
            <T variant="muted">{noGps ? NO_GPS_TEXT : 'Die Ankunftszeit erscheint, sobald dein Standort da ist.'}</T>
          )
        ) : (
          <T variant="muted">Ohne Ziel-Standort: Deine Freunde sehen „unterwegs“, aber keine Ankunftszeit.</T>
        )}
        <T variant="small">{`Für ${joinNames(names)} · ${trip.level === 'precise' ? 'mit genauem Standort' : 'nur Ankunftszeit'}`}</T>
        <T variant="small">
          {trip.destination
            ? `Endet automatisch bei Ankunft, spätestens um ${hhmm(trip.expiresAt)} (${inTime(trip.expiresAt, now)}).`
            : `Endet um ${hhmm(trip.expiresAt)} (${inTime(trip.expiresAt, now)}) oder wenn du es beendest.`}
        </T>
      </Card>

      {watch ? (
        <Card onPress={() => router.push('/watch')} label="Pass auf mich auf ansehen">
          <T variant="h2">🛡️ Pass auf mich auf</T>
          <T variant="small">
            {trip.destination
              ? `Bist du um ${hhmm(watch.dueAt)} nicht angekommen, bekommen ${joinNames(names)} einen Alarm. Kommst du an, endet es von selbst.`
              : `Melde dich bis ${hhmm(watch.dueAt)} mit „Gut angekommen“, sonst bekommen ${joinNames(names)} einen Alarm.`}
          </T>
        </Card>
      ) : null}

      {access === 'while-using' ? (
        <Hint>
          Heyda. darf deinen Standort nur nutzen, solange die App offen ist. Damit die Ankunftszeit auch mit gesperrtem Handy
          aktuell bleibt, erlaube in den Einstellungen „Immer“.
        </Hint>
      ) : null}
      {access === 'denied' ? (
        <Card style={{ borderColor: t.danger }}>
          <T color={t.danger}>Ohne Standortzugriff gibt es keine Ankunftszeit.</T>
          <Button
            title="Standort erlauben"
            kind="secondary"
            compact
            onPress={() => void ensureTrackingAccess(false).then(setAccess).catch(() => {})}
          />
        </Card>
      ) : null}

      <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
        <Button title="Teilen beenden" icon="⏹️" kind="danger" onPress={() => void stop()} busy={busy} />
        <Button title="Neues Ziel / neu starten" kind="secondary" onPress={onNew} />
        <Button title="Fertig" kind="ghost" onPress={() => goBack()} />
      </View>
    </>
  );
}

function TripForm({ onStarted }: { onStarted: () => void }) {
  const t = useTheme();
  const runtime = useRuntime();
  const params = useLocalSearchParams<{ to?: string | string[] }>();
  const { state, activeTrip, isDemo } = useSnapshot();
  const now = useNow(30_000);
  const located = canLocate(isDemo);

  const preset = contactKeyParam(params.to);
  const [recipients, setRecipients] = useState<string[]>(() => {
    if (preset && state.contacts.some((c) => c.key === preset)) return [preset];
    return state.contacts.length === 1 ? [state.contacts[0]!.key] : [];
  });
  const [dest, setDest] = useState<string>(state.places[0]?.id ?? (located ? LINK : NAME));
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [level, setLevel] = useState<SessionLevel>('eta');
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [watchOn, setWatchOn] = useState(false);
  const [watchPick, setWatchPick] = useState(1);
  const [busy, setBusy] = useState(false);
  const [ghostBusy, setGhostBusy] = useState(false);
  const [hasFix, setHasFix] = useState(false);

  // A first position (if allowed already, or the demo one) for the arrival estimate. Never prompts.
  useEffect(() => {
    if (located) void ensureFix(runtime).then(setHasFix).catch(() => {});
  }, [located, runtime]);

  const place = state.places.find((p) => p.id === dest);
  const parsed = useMemo(() => (dest === LINK && link.trim() ? parseLocationInput(link) : null), [dest, link]);
  useEffect(() => {
    if (parsed?.label && !nameTouched) setName(parsed.label.slice(0, LIMITS.destinationName));
  }, [parsed?.label]); // eslint-disable-line react-hooks/exhaustive-deps

  const destination: LatLon | undefined = place ? place.center : parsed ? { lat: parsed.lat, lon: parsed.lon } : undefined;
  const destinationName = (place ? place.name : name).trim().slice(0, LIMITS.destinationName);

  const estimate = useMemo(() => {
    const fix = hasFix ? runtime.node.freshFix(10 * MIN) : undefined;
    if (!fix || !destination) return undefined;
    return bucketEtaMinutes(new EtaEstimator(destination).update(fix).etaSeconds);
  }, [hasFix, destination?.lat, destination?.lon, runtime]); // eslint-disable-line react-hooks/exhaustive-deps

  const watchOptions = (estimate !== undefined && destination ? [estimate + 15, estimate + 30, estimate + 60] : [30, 60, 120, 240]).map(
    (m) => Math.min(MAX_WATCH, Math.max(MIN_WATCH + MIN, Math.ceil(m / 5) * 5 * MIN)),
  );
  const watchDue = now + watchOptions[Math.min(watchPick, watchOptions.length - 1)]!;
  const names = recipients.map((k) => contactLabel(state.contacts.find((c) => c.key === k)));

  const linkBad = dest === LINK && link.trim().length > 0 && !parsed;
  const ready = recipients.length > 0 && destinationName.length > 0 && !(dest === LINK && !parsed) && !busy;

  async function start() {
    if (!ready) return;
    setBusy(true);
    try {
      const needsGps = !!destination || level === 'precise';
      if (needsGps && located && !isDemo) {
        const access = await ensureTrackingAccess(false);
        if (access === 'denied') {
          notice(
            'Standort nötig',
            'Ohne Standortzugriff kann Heyda. keine Ankunftszeit berechnen. Du kannst ihn in den Einstellungen deines Handys erlauben – oder wähle „Nur ein Name“.',
          );
          setBusy(false);
          return;
        }
      }
      if (needsGps && located) await ensureFix(runtime);
      const session = await runtime.node.startTrip({
        recipients,
        destinationName,
        destination,
        level: located ? level : 'eta',
        durationMs: duration,
      });
      if (watchOn) {
        try {
          await runtime.node.startWatch({
            to: recipients,
            label: `Unterwegs nach ${destinationName}`.slice(0, 60),
            dueAt: Date.now() + (watchDue - now),
            tripId: session.id,
          });
        } catch (e) {
          notice('„Pass auf mich auf“ ist nicht gestartet', `Deine Ankunftszeit wird geteilt, aber: ${errorText(e)}`);
        }
      }
      onStarted();
    } catch (e) {
      notice('Nicht gestartet', errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!state.contacts.length) {
    return (
      <Empty
        icon="🚗"
        title="Mit wem teilen?"
        text="Füge zuerst Familie oder Freunde hinzu. Dann kannst du ihnen zeigen, wann du ankommst."
        action={<Button title="Freund hinzufügen" icon="🤝" onPress={() => router.replace('/pair')} />}
      />
    );
  }

  async function ghostOff() {
    setGhostBusy(true);
    try {
      await runtime.node.setGhost(false);
    } catch (e) {
      notice('Hat nicht geklappt', errorText(e));
    } finally {
      setGhostBusy(false);
    }
  }

  // Starting would fail in ghost mode (nothing about my location may leave the phone), so offer to switch it off first.
  if (state.ghost) {
    return (
      <Card style={{ gap: spacing.md, borderColor: t.info }}>
        <T variant="h2">👻 Der Geistmodus ist an</T>
        <T variant="muted">
          Solange er an ist, geht keine Ankunftszeit an deine Freunde – Heyda. teilt nichts über deinen Standort. Ein Notruf (SOS)
          geht trotzdem raus.
        </T>
        <Button title="Geistmodus ausschalten" onPress={() => void ghostOff()} busy={ghostBusy} />
      </Card>
    );
  }

  return (
    <>
      <T variant="muted">
        Deine Freunde sehen, wann du ungefähr ankommst – nicht, wo du gerade bist. Es endet von selbst, wenn du da bist.
      </T>
      {!located ? <Hint>{`${NO_GPS_TEXT} Von hier aus sehen deine Freunde nur „unterwegs nach …“, ohne Ankunftszeit.`}</Hint> : null}
      {activeTrip ? (
        <Hint>{`Deine laufende Fahrt nach „${activeTrip.destinationName}“ wird beim Start beendet und durch die neue ersetzt.`}</Hint>
      ) : null}

      <Section title="Für wen?">
        <ContactPicker contacts={state.contacts} selected={recipients} onChange={setRecipients} max={LIMITS.tripRecipients} />
      </Section>

      <Section title="Wohin?">
        <Wrap>
          {state.places.map((p) => (
            <Chip key={p.id} label={p.name} icon="📍" selected={dest === p.id} onPress={() => setDest(p.id)} />
          ))}
          {located ? <Chip label="Link oder Koordinaten" icon="🔗" selected={dest === LINK} onPress={() => setDest(LINK)} /> : null}
          <Chip label="Nur ein Name" icon="✏️" selected={dest === NAME} onPress={() => setDest(NAME)} />
        </Wrap>
        {dest === LINK ? (
          <>
            <Field
              label="Link aus einer Karten-App oder Koordinaten"
              value={link}
              onChangeText={setLink}
              maxLength={LIMITS.locationInput}
              placeholder="z. B. https://www.openstreetmap.org/… oder 52.5208, 13.4094"
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            {parsed ? (
              <T variant="small" color={t.success}>{`✓ Ziel erkannt (${coords(parsed.lat, parsed.lon)})`}</T>
            ) : linkBad ? (
              <T variant="small" color={t.danger}>
                Das kann die App nicht lesen. Kurzlinks (z. B. maps.app.goo.gl) und Adressen gehen nicht, weil Heyda. nichts im
                Internet nachschlägt. Öffne den Link im Browser und kopiere die lange Adresse, oder kopiere die Koordinaten.
              </T>
            ) : (
              <T variant="small">Geht mit Links von Google Maps, Apple Karten, OpenStreetMap und Waze.</T>
            )}
          </>
        ) : null}
        {dest === LINK || dest === NAME ? (
          <Field
            label="Name des Ziels (sehen deine Freunde)"
            value={name}
            onChangeText={(v) => {
              setName(v);
              setNameTouched(true);
            }}
            maxLength={LIMITS.destinationName}
            placeholder="z. B. Kino, Oma, Arbeit"
          />
        ) : null}
        {dest === NAME ? (
          <Hint>
            Ohne Ziel-Standort gibt es keine Ankunftszeit: Deine Freunde sehen nur „unterwegs nach …“. Die App merkt auch nicht,
            wann du ankommst – es endet nach der gewählten Zeit oder wenn du es beendest.
          </Hint>
        ) : (
          <T variant="small">Nur der Name des Ziels geht an deine Freunde, nie die Adresse.</T>
        )}
        {!state.places.length ? (
          <Button title="Orte speichern (geht dann mit einem Tipp)" kind="ghost" compact onPress={() => router.push('/places')} />
        ) : null}
        {estimate !== undefined && destination ? <T variant="small">{`Geschätzt: ${etaWords(estimate)} mit dem Auto`}</T> : null}
      </Section>

      {located ? (
        <Section title="Was sehen sie?">
          <Choice
            title="Nur Ankunftszeit"
            icon="⏱️"
            detail="Z. B. „ca. 12 Min.“ und das Ziel. Nie, wo du gerade bist."
            selected={level === 'eta'}
            onPress={() => setLevel('eta')}
          />
          <Choice
            title="Genau"
            icon="📌"
            detail="Zusätzlich dein genauer Standort auf ihrer Karte, bis du ankommst. Gut fürs Abholen oder für Treffpunkte."
            selected={level === 'precise'}
            onPress={() => setLevel('precise')}
          />
        </Section>
      ) : null}

      <Section title="Wie lange höchstens?">
        <Wrap>
          {DURATIONS.map((d) => (
            <Chip key={d} label={durationWords(d)} selected={duration === d} onPress={() => setDuration(d)} />
          ))}
        </Wrap>
        <T variant="small">
          {destination
            ? `Endet automatisch, wenn du ankommst – spätestens um ${hhmm(now + duration)}.`
            : `Endet um ${hhmm(now + duration)} oder wenn du es beendest.`}
        </T>
      </Section>

      <Section title="Pass auf mich auf">
        <Card style={{ gap: spacing.md }}>
          <Toggle
            label="🛡️ Alarm, falls ich nicht ankomme"
            detail={
              destination
                ? `Bist du bis zur gewählten Zeit nicht da, bekommen ${names.length ? joinNames(names) : 'deine Kontakte'} einen Alarm – auch wenn dein Handy aus ist. Kommst du an, endet es von selbst.`
                : `Melde dich bis zur gewählten Zeit mit „Gut angekommen“, sonst bekommen ${names.length ? joinNames(names) : 'deine Kontakte'} einen Alarm – auch wenn dein Handy aus ist.`
            }
            value={watchOn}
            onChange={setWatchOn}
          />
          {watchOn ? (
            <>
              <Wrap>
                {watchOptions.map((ms, i) => (
                  <Chip key={`${i}-${ms}`} label={`bis ${hhmm(now + ms)}`} selected={watchPick === i} onPress={() => setWatchPick(i)} />
                ))}
              </Wrap>
              <T variant="small">{`Alarm um ${hhmm(watchDue)} (${inTime(watchDue, now)}), falls du bis dahin nicht angekommen bist.`}</T>
            </>
          ) : null}
        </Card>
      </Section>

      <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
        <Button title="Teilen starten" icon="🚗" onPress={() => void start()} disabled={!ready} busy={busy} />
        {!recipients.length ? (
          <T variant="small" style={{ textAlign: 'center' }}>
            Wähle mindestens eine Person.
          </T>
        ) : !destinationName || (dest === LINK && !parsed) ? (
          <T variant="small" style={{ textAlign: 'center' }}>
            {dest === LINK && !parsed ? 'Füge einen Link oder Koordinaten ein.' : 'Gib dem Ziel einen Namen.'}
          </T>
        ) : (
          <Row style={{ justifyContent: 'center' }}>
            <T variant="small" style={{ textAlign: 'center' }}>
              {`${joinNames(names)} ${names.length === 1 ? 'bekommt' : 'bekommen'} eine Nachricht, dass du unterwegs bist.`}
            </T>
          </Row>
        )}
        {located && !isDemo ? (
          <T variant="small" style={{ textAlign: 'center' }}>
            Für eine aktuelle Ankunftszeit auch bei gesperrtem Handy fragt Heyda. nach dem Standort „Immer“. Er bleibt auf deinem Handy.
          </T>
        ) : null}
      </View>
    </>
  );
}
