import { contactLabel, type Cell, type Point } from '@heyda/core';
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Text, useWindowDimensions, View } from 'react-native';
import { cellSize, coarseWords } from '../../components/social/describe';
import { ago, errorText } from '../../components/social/format';
import { ListCard, ListRow, Narrow } from '../../components/social/kit';
import { myPosition } from '../../components/social/location';
import { TileMap, type MapMarker } from '../../components/TileMap';
import { Button, Card, Empty, Row, Screen, Section, T } from '../../components/ui';
import { notice } from '../../lib/confirm';
import { openInMaps } from '../../lib/emergency';
import { isNative } from '../../lib/platform';
import { useRuntime, useSnapshot } from '../../lib/store';
import { useNow } from '../../components/social/useNow';
import { spacing, useTheme } from '../../lib/theme';

const DAY = 24 * 3600_000;

interface Item {
  id: string;
  icon: string;
  title: string;
  detail: string;
  kind: MapMarker['kind'];
  point?: Point;
  cell?: Cell;
  href?: Href;
  /** Someone else's data (not my own places or position). */
  shared: boolean;
}

export default function MapTab() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, statuses, settings, isDemo } = useSnapshot();
  const now = useNow(30_000);
  const { height } = useWindowDimensions();
  const [focus, setFocus] = useState<{ lat: number; lon: number; zoom: number }>();
  const [me, setMe] = useState<{ lat: number; lon: number; accuracyM?: number }>();
  const [locating, setLocating] = useState(false);

  const items: Item[] = [];
  for (const c of state.contacts) {
    const s = statuses[c.key];
    if (!s) continue;
    const name = contactLabel(c);
    const contactHref: Href = { pathname: '/contact/[key]', params: { key: c.key } };
    if (s.sos && !s.sos.endedAt && s.sos.point) {
      items.push({
        id: `sos-${c.key}`,
        icon: '🆘',
        title: `${name} braucht Hilfe`,
        detail: `Genauer Standort aus dem Notruf · ${ago(s.sos.pointAt ?? s.sos.startedAt, now)}`,
        kind: 'sos',
        point: s.sos.point,
        href: { pathname: '/sos-alert/[key]', params: { key: c.key } },
        shared: true,
      });
    }
    const live = s.live && (!s.live.expiresAt || s.live.expiresAt > now) ? s.live : undefined;
    if (live?.point && live.level === 'precise') {
      items.push({ id: `live-${c.key}`, icon: '📡', title: name, detail: `Live, genau · ${ago(live.updatedAt, now)}`, kind: 'friend', point: live.point, href: contactHref, shared: true });
    } else if (live?.cell) {
      items.push({
        id: `live-${c.key}`,
        icon: '📡',
        title: name,
        detail: `Live, ${coarseWords(live.cell.cellM)} · ${ago(live.updatedAt, now)}`,
        kind: 'friend',
        cell: live.cell,
        href: contactHref,
        shared: true,
      });
    }
    if (s.trip?.point && s.trip.level === 'precise') {
      items.push({ id: `trip-${c.key}`, icon: '🚗', title: `${name} (unterwegs)`, detail: `nach „${s.trip.destinationName}“, genau · ${ago(s.trip.updatedAt, now)}`, kind: 'friend', point: s.trip.point, href: contactHref, shared: true });
    } else if (s.trip?.cell && s.trip.level !== 'eta') {
      items.push({ id: `trip-${c.key}`, icon: '🚗', title: `${name} (unterwegs)`, detail: `nach „${s.trip.destinationName}“, ${coarseWords(s.trip.cell.cellM)} · ${ago(s.trip.updatedAt, now)}`, kind: 'friend', cell: s.trip.cell, href: contactHref, shared: true });
    }
    const w = s.lastWhere;
    if (w && now - w.at < DAY) {
      const href: Href = { pathname: '/where/[key]', params: { key: c.key } };
      if (w.answer === 'precise' && w.point) {
        items.push({ id: `where-${c.key}`, icon: '🧭', title: name, detail: `Antwort auf „Wo bist du?“, genau · ${ago(w.at, now)}`, kind: 'friend', point: w.point, href, shared: true });
      } else if (w.answer === 'coarse' && w.cell) {
        items.push({ id: `where-${c.key}`, icon: '🧭', title: name, detail: `Antwort auf „Wo bist du?“, ${coarseWords(w.cell.cellM)} · ${ago(w.at, now)}`, kind: 'friend', cell: w.cell, href, shared: true });
      }
    }
  }
  const sharedCount = items.length;
  for (const p of state.places) {
    items.push({ id: `place-${p.id}`, icon: '📍', title: p.name, detail: 'Dein Ort', kind: 'place', point: { lat: p.center.lat, lon: p.center.lon, accuracyM: p.radiusM }, shared: false });
  }
  if (me) {
    items.push({ id: 'me', icon: '🔵', title: 'Du', detail: 'Nur auf deinem Gerät, wird nicht geteilt', kind: 'me', point: { lat: me.lat, lon: me.lon, accuracyM: me.accuracyM ?? 0 }, shared: false });
  }

  const markers: MapMarker[] = items.map((i) => {
    const at = i.point ?? i.cell!;
    return {
      id: i.id,
      lat: at.lat,
      lon: at.lon,
      label: i.cell ? `${i.title} (ungefähr)` : i.title,
      kind: i.kind,
      accuracyM: i.point && i.kind !== 'place' ? i.point.accuracyM : undefined,
      cellM: i.cell?.cellM,
    };
  });

  async function showMe() {
    setLocating(true);
    try {
      const p = await myPosition();
      if (!p) {
        notice('Standort nicht erlaubt', 'Erlaube Heyda. den Standort in den Einstellungen, um dich auf der Karte zu sehen.');
        return;
      }
      setMe(p);
      setFocus({ lat: p.lat, lon: p.lon, zoom: 15 });
    } catch (e) {
      notice('Standort gerade unbekannt', errorText(e));
    } finally {
      setLocating(false);
    }
  }

  const mapHeight = Math.round(Math.min(520, Math.max(260, height * 0.45)));
  const list = items.filter((i) => i.kind !== 'me');

  return (
    <Screen title="Karte">
      <Narrow>
        {!settings.mapEnabled ? (
          <Card style={{ gap: spacing.md }}>
            <Text style={{ fontSize: 40, textAlign: 'center' }} accessible={false}>
              🗺️
            </Text>
            <T variant="h2" style={{ textAlign: 'center' }}>
              Karte einschalten?
            </T>
            <T variant="muted">
              Die Kartenbilder kommen von openstreetmap.org. Dieser Dienst sieht dabei ungefähr, welche Gegend du dir ansiehst –
              aber nicht, wer deine Freunde sind. Was deine Freunde mit dir teilen, bleibt Ende-zu-Ende-verschlüsselt und geht
              nicht an openstreetmap.org.
            </T>
            <Button title="Karte einschalten" icon="🗺️" onPress={() => runtime.updateSettings({ mapEnabled: true })} />
            <T variant="small" style={{ textAlign: 'center' }}>
              Du kannst sie jederzeit wieder ausschalten. Ohne Karte siehst du alles unten als Liste.
            </T>
          </Card>
        ) : (
          <>
            <TileMap markers={markers} height={mapHeight} center={focus} zoom={focus?.zoom} />
            <Row gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
              {isNative && !isDemo ? (
                me ? (
                  <Button title="Mich ausblenden" icon="🔵" kind="secondary" compact onPress={() => setMe(undefined)} />
                ) : (
                  <Button title="Mich zeigen" icon="🔵" kind="secondary" compact busy={locating} onPress={() => void showMe()} />
                )
              ) : null}
              <Button title="Karte ausschalten" kind="ghost" compact onPress={() => runtime.updateSettings({ mapEnabled: false })} />
            </Row>
            <T variant="small">
              {`Gestrichelte Felder sind ungefähre Gegenden (${cellSize()}): Die Person ist irgendwo darin, nicht unbedingt in der Mitte. Dein eigener Standort erscheint nur, wenn du „Mich zeigen“ tippst.`}
            </T>
          </>
        )}

        {sharedCount === 0 ? (
          <Empty
            icon="🌙"
            title="Gerade teilt niemand einen Standort mit dir"
            text="Hier erscheinen Live-Standorte, genaue Antworten auf „Wo bist du?“ und Notrufe – nur, wenn jemand das selbst teilt."
            action={
              state.contacts.length ? (
                <Button title="Selbst live teilen" icon="📡" kind="secondary" onPress={() => router.push('/live')} />
              ) : (
                <Button title="Freund hinzufügen" icon="🤝" onPress={() => router.push('/pair')} />
              )
            }
          />
        ) : null}

        {list.length ? (
          <Section title={sharedCount ? 'Auf der Karte' : 'Deine Orte'}>
            <ListCard>
              {list.map((i, idx) => (
                <ListRow key={i.id} first={idx === 0}>
                  <Row gap={spacing.md} style={{ alignItems: 'flex-start' }}>
                    <Text style={{ fontSize: 20, width: 28, textAlign: 'center' }} accessible={false}>
                      {i.icon}
                    </Text>
                    <View style={{ flex: 1, gap: 2 }}>
                      <T variant="h2" style={{ fontSize: 15 }} color={i.kind === 'sos' ? t.danger : undefined}>
                        {i.title}
                      </T>
                      <T variant="small">{i.detail}</T>
                      <Row gap={spacing.xs} style={{ flexWrap: 'wrap' }}>
                        {settings.mapEnabled ? (
                          <Button
                            title="Zeigen"
                            kind="ghost"
                            compact
                            onPress={() => {
                              const at = i.point ?? i.cell!;
                              setFocus({ lat: at.lat, lon: at.lon, zoom: i.cell ? 12 : 16 });
                            }}
                          />
                        ) : null}
                        {i.point && i.shared ? (
                          <Button
                            title="In Karten öffnen"
                            kind="ghost"
                            compact
                            onPress={() => void openInMaps(i.point!.lat, i.point!.lon, i.title).catch(() => {})}
                          />
                        ) : null}
                        {i.href ? <Button title="Details" kind="ghost" compact onPress={() => router.push(i.href!)} /> : null}
                      </Row>
                    </View>
                  </Row>
                </ListRow>
              ))}
            </ListCard>
          </Section>
        ) : null}
      </Narrow>
    </Screen>
  );
}
