import { contactLabel, parseLocationInput, type Place } from '@heyda/core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Banner, Bullet, errorText, Field, leave, Narrow, NotFound, param } from '../../components/setup/kit';
import { TileMap } from '../../components/TileMap';
import { Button, Card, Chip, Screen, Section, T, Wrap } from '../../components/ui';
import { confirm, notice } from '../../lib/confirm';
import { openInMaps } from '../../lib/emergency';
import { currentLocationAccess, currentPosition, locationSupported, MAX_REGIONS, requestLocationAccess } from '../../lib/location';
import { isDesktop } from '../../lib/platform';
import { useRuntime, useSnapshot } from '../../lib/store';
import { spacing, useTheme } from '../../lib/theme';

const NAME_MAX = 60;
const NAME_SUGGESTIONS = ['Zuhause', 'Arbeit', 'Schule', 'Uni', 'Sport', 'Oma & Opa'];
const RADII = [50, 100, 200, 500];
/** Bounds the core accepts when places sync between my devices. */
const RADIUS_MIN = 10;
const RADIUS_MAX = 50_000;
/** Below this the phone's geofencing gets unreliable (it watches at least this much). */
const RELIABLE_RADIUS = 100;
/** A made-up spot for the demo; the real location is never used there. */
const DEMO_CENTER = { lat: 52.5208, lon: 13.4094 };

type Source = 'saved' | 'gps' | 'demo' | 'paste' | 'map';
const SOURCE_TEXT: Record<Source, string> = {
  saved: 'gespeichert',
  gps: 'dein aktueller Standort',
  demo: 'Demo-Standort',
  paste: 'aus dem Link',
  map: 'auf der Karte gewählt',
};

export default function PlaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state } = useSnapshot();
  const placeId = param(id);
  if (placeId === 'new') return <PlaceEditor />;
  const place = /^[A-Za-z0-9_-]{1,64}$/.test(placeId) ? state.places.find((p) => p.id === placeId) : undefined;
  if (!place) {
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: 'Ort' }} />
        <Narrow>
          <NotFound
            title="Ort nicht gefunden"
            text="Diesen Ort gibt es nicht (mehr). Vielleicht wurde er auf einem anderen Gerät gelöscht."
            action={<Button title="Zu meinen Orten" kind="secondary" onPress={() => router.replace('/places')} />}
          />
        </Narrow>
      </Screen>
    );
  }
  return <PlaceEditor key={place.id} place={place} />;
}

function PlaceEditor({ place }: { place?: Place }) {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, settings, isDemo } = useSnapshot();
  const [name, setName] = useState(place?.name ?? '');
  const [center, setCenter] = useState<{ lat: number; lon: number } | undefined>(place?.center);
  const [source, setSource] = useState<Source | undefined>(place ? 'saved' : undefined);
  const [accuracy, setAccuracy] = useState<number>();
  const [mapKey, setMapKey] = useState(0);
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string>();
  const [gpsError, setGpsError] = useState<string>();
  const [gpsNote, setGpsNote] = useState<string>();
  const [radiusM, setRadiusM] = useState(place?.radiusM ?? 100);
  const [customOpen, setCustomOpen] = useState(place ? !RADII.includes(place.radiusM) : false);
  const [customText, setCustomText] = useState(place && !RADII.includes(place.radiusM) ? String(place.radiusM) : '');
  const [viewers, setViewers] = useState<Set<string>>(
    () => new Set(place ? state.grants.filter((g) => g.placeIds.includes(place.id)).map((g) => g.contactKey) : []),
  );
  const [busy, setBusy] = useState<'gps' | 'save'>();
  const [tried, setTried] = useState(false);

  const isNew = !place;
  const full = isNew && state.places.length >= MAX_REGIONS;
  const cleanName = name.trim();
  const customNum = Number(customText);
  const customBad = customOpen && (customText === '' || !Number.isInteger(customNum) || customNum < RADIUS_MIN || customNum > RADIUS_MAX);
  const canGps = isDemo || locationSupported;
  const usedByRules = place ? state.rules.filter((r) => JSON.stringify([r.trigger, r.conditions, r.actions]).includes(`"${place.id}"`)).length : 0;

  function pickCenter(p: { lat: number; lon: number }, s: Source, refit = true) {
    setCenter({ lat: p.lat, lon: p.lon });
    setSource(s);
    if (s !== 'gps') setAccuracy(undefined);
    if (refit) setMapKey((k) => k + 1);
  }

  async function useHere() {
    setGpsError(undefined);
    setGpsNote(undefined);
    if (isDemo) {
      pickCenter({ lat: DEMO_CENTER.lat + state.places.length * 0.004, lon: DEMO_CENTER.lon + 0.002 }, 'demo');
      return;
    }
    if (!locationSupported) return;
    setBusy('gps');
    try {
      let access = await currentLocationAccess();
      if (access === 'denied') access = await requestLocationAccess();
      if (access === 'denied') {
        setGpsError('Ohne Standortzugriff geht das nicht. Du kannst stattdessen einen Kartenlink einfügen.');
        return;
      }
      if (access === 'while-using') setGpsNote('Für Ankunft und Abfahrt bei geschlossener App braucht Heyda. später „Immer erlauben“.');
      const pos = await currentPosition();
      pickCenter(pos, 'gps');
      setAccuracy(pos.accuracyM);
    } catch (e) {
      setGpsError(errorText(e, 'Standort nicht gefunden. Versuch es draußen oder am Fenster nochmal.'));
    } finally {
      setBusy(undefined);
    }
  }

  /** Reads a pasted link or coordinates. `quiet`: no error yet (the person may still be typing). */
  function applyPaste(text: string, quiet: boolean) {
    setPasteError(undefined);
    if (!text.trim()) return;
    const r = parseLocationInput(text);
    if (!r) {
      if (!quiet) {
        setPasteError(
          'Das konnte ich nicht lesen. Kurzlinks wie „maps.app.goo.gl“ gehen leider nicht: Öffne den Link und kopiere die lange Adresse, oder kopiere die Koordinaten (z. B. 52.5208, 13.4094).',
        );
      }
      return;
    }
    pickCenter(r, 'paste');
    if (!cleanName && r.label) setName(r.label.slice(0, NAME_MAX));
  }

  function onPasteChange(text: string) {
    const jump = text.length - paste.length > 3;
    setPaste(text);
    // A paste arrives in one go: use it right away. Typing waits for "Übernehmen".
    if (jump) applyPaste(text, true);
    else setPasteError(undefined);
  }

  function chooseRadius(r: number) {
    setCustomOpen(false);
    setRadiusM(r);
  }

  function toggleViewer(key: string) {
    setViewers((v) => {
      const next = new Set(v);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function save() {
    setTried(true);
    if (!cleanName || !center || customBad || full || busy) return;
    setBusy('save');
    try {
      const id = runtime.savePlace({ id: place?.id, name: cleanName.slice(0, NAME_MAX), center, radiusM: customOpen ? customNum : radiusM });
      // Merge with each contact's other places: only change what changed here.
      for (const c of state.contacts) {
        const current = runtime.node.getState().grants.find((g) => g.contactKey === c.key)?.placeIds ?? [];
        const has = current.includes(id);
        const want = viewers.has(c.key);
        if (has !== want) runtime.setPlaceGrant(c.key, want ? [...current, id] : current.filter((x) => x !== id));
      }
      leave('/places');
    } catch (e) {
      notice('Nicht gespeichert', errorText(e));
      setBusy(undefined);
    }
  }

  async function remove() {
    if (!place) return;
    const ok = await confirm({
      title: `„${place.name}“ löschen?`,
      message: `Freunde bekommen für diesen Ort dann keine Hinweise mehr.${usedByRules ? ` ${usedByRules} ${usedByRules === 1 ? 'Automation nutzt' : 'Automationen nutzen'} diesen Ort und ${usedByRules === 1 ? 'funktioniert' : 'funktionieren'} dann nicht mehr.` : ''}`,
      ok: 'Löschen',
      destructive: true,
    });
    if (!ok) return;
    leave('/places');
    runtime.removePlace(place.id);
  }

  const shownRadius = customOpen && !customBad ? customNum : radiusM;
  const problems = [!cleanName && 'Gib dem Ort einen Namen.', !center && 'Lege den Mittelpunkt fest.', customBad && `Umkreis: ${RADIUS_MIN} bis ${RADIUS_MAX} Meter.`].filter(Boolean) as string[];

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: isNew ? 'Neuer Ort' : place.name }} />
      <Narrow>
        {full && (
          <Banner tone="warn" title={`Höchstens ${MAX_REGIONS} Orte`}>
            {`Dein Handy kann nur ${MAX_REGIONS} Orte gleichzeitig überwachen. Lösche zuerst einen anderen Ort.`}
          </Banner>
        )}

        <Section title="Name">
          <Field value={name} onChangeText={setName} maxLength={NAME_MAX} placeholder="z. B. Zuhause" autoCapitalize="words" counter />
          <Wrap>
            {NAME_SUGGESTIONS.map((n) => (
              <Chip key={n} label={n} selected={name === n} onPress={() => setName(n)} />
            ))}
          </Wrap>
          <T variant="small">Diesen Namen sehen Freunde, die du unten auswählst: „Lisa ist bei Zuhause angekommen“.</T>
        </Section>

        <Section title="Wo ist der Ort?">
          {center && source ? (
            <Card style={{ gap: spacing.xs, borderColor: t.success }}>
              <T style={{ fontWeight: '700' }} color={t.success}>
                {`✅ Mittelpunkt gesetzt (${SOURCE_TEXT[source]}${accuracy ? `, ±${Math.round(accuracy)} m` : ''})`}
              </T>
              <T variant="small">{`${center.lat.toFixed(5)}, ${center.lon.toFixed(5)} · nur auf deinem Gerät`}</T>
              {!settings.mapEnabled && !isDemo && (
                <Button title="In Karten-App prüfen" kind="ghost" compact onPress={() => void openInMaps(center.lat, center.lon, cleanName || 'Ort').catch(() => {})} style={{ alignSelf: 'flex-start' }} />
              )}
            </Card>
          ) : (
            <T variant="muted">Wähle eine der Möglichkeiten unten.</T>
          )}

          <Card style={{ gap: spacing.sm }}>
            <T variant="h2">📍 Aktueller Standort</T>
            {canGps ? (
              <>
                <T variant="small">{isDemo ? 'In der Demo nimmt die App einen erfundenen Punkt in Berlin.' : 'Am besten, während du gerade dort bist.'}</T>
                <Button title="Hier bin ich gerade" kind="secondary" compact onPress={() => void useHere()} busy={busy === 'gps'} />
                {gpsError && <T variant="small" color={t.danger}>{gpsError}</T>}
                {gpsNote && <T variant="small" color={t.accent}>{gpsNote}</T>}
              </>
            ) : (
              <T variant="small">{isDesktop ? 'Am PC gibt es kein GPS. Füge einen Kartenlink ein oder tippe auf die Karte.' : 'Hier gibt es keinen Standort. Füge einen Kartenlink ein.'}</T>
            )}
          </Card>

          <Card style={{ gap: spacing.sm }}>
            <T variant="h2">🔗 Kartenlink oder Koordinaten</T>
            <T variant="small">Aus Google Maps, Apple Karten oder OpenStreetMap: „Teilen“ → Link kopieren und hier einfügen.</T>
            <Field
              value={paste}
              onChangeText={onPasteChange}
              placeholder="https://… oder 52.5208, 13.4094"
              autoCapitalize="none"
              maxLength={2000}
              error={pasteError}
              onSubmitEditing={() => applyPaste(paste, false)}
            />
            <Button title="Übernehmen" kind="secondary" compact onPress={() => applyPaste(paste, false)} disabled={!paste.trim()} />
          </Card>

          {settings.mapEnabled ? (
            <Card style={{ gap: spacing.sm }}>
              <T variant="h2">🗺️ Auf der Karte tippen</T>
              <TileMap
                key={mapKey}
                height={260}
                markers={center ? [{ id: 'center', lat: center.lat, lon: center.lon, label: cleanName || 'Neuer Ort', kind: 'place', accuracyM: shownRadius }] : []}
                onPress={(p) => pickCenter(p, 'map', false)}
              />
              <T variant="small">Tippe auf die Stelle, die der Mittelpunkt sein soll. Zum Zoomen doppelt tippen.</T>
            </Card>
          ) : (
            <View style={{ gap: spacing.xs }}>
              <T variant="small">Lieber auf einer Karte tippen? Die Karte ist aus, weil OpenStreetMap sonst sieht, welche Gegend du anschaust.</T>
              <Button title="Karte in den Einstellungen einschalten" kind="ghost" compact onPress={() => router.push('/settings')} style={{ alignSelf: 'flex-start' }} />
            </View>
          )}
        </Section>

        <Section title="Wie groß?">
          <Wrap>
            {RADII.map((r) => (
              <Chip key={r} label={`${r} m`} selected={!customOpen && radiusM === r} onPress={() => chooseRadius(r)} />
            ))}
            <Chip label="Eigener Wert" selected={customOpen} onPress={() => setCustomOpen(true)} />
          </Wrap>
          {customOpen && (
            <Field
              label={`Umkreis in Metern (${RADIUS_MIN} bis ${RADIUS_MAX})`}
              value={customText}
              onChangeText={(v) => setCustomText(v.replace(/\D/g, '').slice(0, 5))}
              keyboardType="number-pad"
              maxLength={5}
              error={customText !== '' && customBad ? `Bitte eine Zahl von ${RADIUS_MIN} bis ${RADIUS_MAX}.` : undefined}
            />
          )}
          <T variant="small">
            {shownRadius < RELIABLE_RADIUS
              ? `Unter ${RELIABLE_RADIUS} m erkennt das Handy Ankunft oft ungenau. Es passt dann mindestens ${RELIABLE_RADIUS} m auf.`
              : 'Für ein Haus reichen meist 100 m, für ein Gelände wie Schule oder Uni eher 200–500 m.'}
          </T>
        </Section>

        <Section title="Wer bekommt Bescheid?">
          {state.contacts.length ? (
            <Wrap>
              {state.contacts.map((c) => (
                <Chip key={c.key} icon={viewers.has(c.key) ? '🔔' : undefined} label={contactLabel(c)} selected={viewers.has(c.key)} onPress={() => toggleViewer(c.key)} />
              ))}
            </Wrap>
          ) : (
            <Card>
              <T variant="muted">Noch keine Freunde. Du kannst den Ort trotzdem für deine Automationen speichern.</T>
              <Button title="Freund hinzufügen" kind="ghost" compact onPress={() => router.push('/pair')} style={{ alignSelf: 'flex-start' }} />
            </Card>
          )}
          <Bullet icon="🔒">
            Wen du auswählst, bekommt nur „ist angekommen“ oder „ist losgegangen“ mit dem Namen des Ortes. Keine Koordinaten, keine Karte. Im Geistmodus geht gar nichts raus.
          </Bullet>
        </Section>

        <View style={{ gap: spacing.md, marginTop: spacing.xl }}>
          {tried && problems.length > 0 && (
            <Banner tone="danger" title="Noch offen">
              {problems.join(' ')}
            </Banner>
          )}
          <Button title={isNew ? 'Ort speichern' : 'Änderungen speichern'} icon="📍" onPress={save} busy={busy === 'save'} disabled={full || (tried && problems.length > 0)} />
          {place && <Button title="Ort löschen" kind="danger" onPress={() => void remove()} />}
          <T variant="small">{`Dein Handy überwacht bis zu ${MAX_REGIONS} Orte gleichzeitig.`}</T>
        </View>
      </Narrow>
    </Screen>
  );
}
