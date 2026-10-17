import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Image, Linking, PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { radius, TOUCH, useTheme, type Theme } from '../lib/theme';
import { clampCamera, fitCamera, fromScreen, MAX_ZOOM, metersPerPixel, MIN_ZOOM, project, rangeOrigin } from './tile-math';
import { tileRange, tileSlots, toScreen, unproject, worldSize, zoomAt, type Camera } from './tile-math';

export interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  label: string;
  kind: 'me' | 'friend' | 'sos' | 'place' | 'destination';
  accuracyM?: number; // draws a circle
  cellM?: number; // draws a square for coarse (grid) locations
}

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_HEADERS = { 'User-Agent': 'Heyda/1.0 (+https://github.com/ExelerX)' }; // OSM tile usage policy
const NO_MARKERS: Camera = { ...project(51.16, 10.45), z: 5 }; // Germany
/**
 * The closest the map zooms by itself while it shows someone else's location (about 6 km across
 * in Germany): the tile server sees which tiles are loaded, so it learns only the rough area.
 * Closer only when the person zooms in themselves.
 */
const SHARED_FIT_ZOOM = 12;
const TAP_SLOP = 6;
const DOUBLE_TAP_MS = 250;
const WEB_SURFACE = (Platform.OS === 'web' ? { cursor: 'grab', userSelect: 'none', touchAction: 'none' } : {}) as ViewStyle;
const markerColor = (t: Theme, kind: MapMarker['kind']) =>
  ({ me: t.info, friend: t.accent, sos: t.danger, place: t.textMuted, destination: t.accent })[kind];

/**
 * OpenStreetMap raster tiles drawn with plain Image components (Android, iOS, web/desktop).
 * Drag to pan; buttons, double tap, pinch or mouse wheel to zoom; tap to pick a point (onPress).
 * Mount it only after the user enabled the map: the tile server sees which area is viewed.
 * Fitting to markers of other people stops at SHARED_FIT_ZOOM.
 */
export function TileMap({ markers, height = 280, center, zoom, onPress, tileUrl = OSM_TILES }: {
  markers: MapMarker[];
  height?: number;
  center?: { lat: number; lon: number };
  zoom?: number;
  onPress?: (p: { lat: number; lon: number }) => void;
  tileUrl?: string;
}) {
  const t = useTheme();
  const [size, setSize] = useState({ w: 0, h: height });
  const [cam, setCam] = useState<Camera | null>(null);
  const userMoved = useRef(false);
  const fittedMarkers = useRef(false);
  const c = cam ? clampCamera(cam, size.h) : null;

  const fit = (): Camera => {
    const pts = markers.map((m) => ({ ...m, radiusM: Math.max(m.accuracyM ?? 0, (m.cellM ?? 0) * 0.71) }));
    const shared = markers.some((m) => m.kind === 'friend' || m.kind === 'sos');
    const f = fitCamera(pts, size.w, size.h, shared ? { maxZoom: SHARED_FIT_ZOOM, singleZoom: SHARED_FIT_ZOOM } : undefined) ?? NO_MARKERS;
    return zoom === undefined ? f : { ...f, z: zoom };
  };
  // Follow center/zoom props. Without them fit the markers once the size is known, and once
  // more when the first markers arrive (unless the user has moved the map by then).
  useEffect(() => {
    if (center) setCam({ ...project(center.lat, center.lon), z: zoom ?? 15 });
  }, [center?.lat, center?.lon, zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (center || size.w === 0 || (cam && (fittedMarkers.current || userMoved.current || !markers.length))) return;
    setCam(fit());
    fittedMarkers.current = markers.length > 0;
  }, [size.w, size.h, markers.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Gesture handlers are created once and read the latest values through `live`.
  const live = useRef({ c, size, onPress });
  live.current = { c, size, onPress };
  const go = (next: Camera) => {
    userMoved.current = true;
    setCam(clampCamera(next, live.current.size.h));
  };
  const zoomBy = (dz: number, x?: number, y?: number) => {
    const { c: now, size: s } = live.current;
    if (now) go(zoomAt(now, dz, x ?? s.w / 2, y ?? s.h / 2, s.w, s.h));
  };

  const lastTap = useRef<{ at: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => () => clearTimeout(lastTap.current?.timer), []);
  const onTap = (x: number, y: number) => {
    const prev = lastTap.current;
    if (prev && Date.now() - prev.at < DOUBLE_TAP_MS && Math.hypot(x - prev.x, y - prev.y) < 30) {
      clearTimeout(prev.timer);
      lastTap.current = null;
      return zoomBy(1, x, y);
    }
    const { c: now, size: s, onPress: cb } = live.current;
    const p = now ? fromScreen(x, y, now, s.w, s.h) : null;
    // Wait for a possible second tap, so a double tap zooms instead of picking a point.
    const timer = setTimeout(() => {
      lastTap.current = null;
      if (cb && p && p.y >= 0 && p.y <= 1) cb(unproject(p));
    }, DOUBLE_TAP_MS);
    lastTap.current = { at: Date.now(), x, y, timer };
  };

  const gesture = useRef<{ start: Camera; x: number; y: number; moved: boolean; pinch?: number } | null>(null);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          const start = live.current.c;
          const { locationX: x, locationY: y } = e.nativeEvent;
          gesture.current = start ? { start, x, y, moved: false } : null;
        },
        onPanResponderMove: (e, g) => {
          const s = gesture.current;
          if (!s) return;
          const touches = e.nativeEvent.touches ?? [];
          if (touches.length >= 2 || s.pinch !== undefined) {
            // Pinch: one zoom level per 1.6x change of finger distance; no panning afterwards.
            s.moved = true;
            const [a, b] = touches;
            if (!a || !b) return;
            const d = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
            if (s.pinch === undefined) s.pinch = d;
            else if (d > s.pinch * 1.6 || d < s.pinch / 1.6) {
              zoomBy(d > s.pinch ? 1 : -1);
              s.pinch = d;
            }
            return;
          }
          if (!s.moved && Math.hypot(g.dx, g.dy) < TAP_SLOP) return;
          s.moved = true;
          const ws = worldSize(s.start.z);
          go({ x: s.start.x - g.dx / ws, y: s.start.y - g.dy / ws, z: s.start.z });
        },
        onPanResponderRelease: () => {
          const s = gesture.current;
          gesture.current = null;
          if (s && !s.moved) onTap(s.x, s.y);
        },
        onPanResponderTerminate: () => (gesture.current = null),
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Mouse wheel zoom on web/desktop, towards the cursor.
  const surface = useRef<View>(null);
  useEffect(() => {
    const el = surface.current as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !el?.addEventListener) return;
    let [acc, lastEvent, lastStep] = [0, 0, 0];
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.timeStamp - lastEvent > 300) acc = 0;
      lastEvent = e.timeStamp;
      acc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      if (Math.abs(acc) < 80 || e.timeStamp - lastStep < 200) return;
      const r = el.getBoundingClientRect();
      zoomBy(acc < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
      [acc, lastStep] = [0, e.timeStamp];
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pulse = useRef(new Animated.Value(0)).current;
  const hasSos = markers.some((m) => m.kind === 'sos');
  useEffect(() => {
    if (!hasSos) return;
    const native = Platform.OS !== 'web';
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.ease), useNativeDriver: native }));
    loop.start();
    return () => loop.stop();
  }, [hasSos, pulse]);

  // Tiles only re-render when the set of tiles changes; panning just moves their container.
  const range = c && size.w > 0 ? tileRange(c, size.w, size.h) : null;
  const rangeKey = range ? `${range.z}/${range.x0}/${range.x1}/${range.y0}/${range.y1}` : '';
  const tiles = useMemo(
    () =>
      range &&
      tileSlots(range, tileUrl).map((s) => (
        // The slot's neutral background stays visible while a tile loads or when it fails.
        <View key={s.key} style={[styles.tile, { left: s.left, top: s.top, backgroundColor: t.surfaceRaised }]}>
          <Image source={Platform.OS === 'web' ? { uri: s.url } : { uri: s.url, headers: TILE_HEADERS }} style={styles.tileImage} />
        </View>
      )),
    [rangeKey, tileUrl, t.surfaceRaised], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const origin = range && c ? rangeOrigin(range, c, size.w, size.h) : null;
  const placed = !c ? [] : markers.map((m) => {
    const mpp = metersPerPixel(m.lat, c.z);
    const pos = toScreen(project(m.lat, m.lon), c, size.w, size.h);
    return { m, ...pos, color: markerColor(t, m.kind), acc: (m.accuracyM ?? 0) / mpp, cell: (m.cellM ?? 0) / mpp };
  });
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 3] });
  const fade = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] });

  return (
    <View
      style={[styles.map, { height, backgroundColor: t.surfaceRaised, borderColor: t.border }]}
      onLayout={(e) => setSize({ w: Math.round(e.nativeEvent.layout.width), h: Math.round(e.nativeEvent.layout.height) })}
    >
      {origin && <View style={{ position: 'absolute', left: origin.left, top: origin.top }}>{tiles}</View>}
      {size.w > 0 && (
        <Svg width={size.w} height={size.h} style={StyleSheet.absoluteFill}>
          {placed.flatMap(({ m, left, top, color, acc, cell }) => [
            cell > 0 ? <Rect key={`${m.id}-c`} x={left - cell / 2} y={top - cell / 2} width={cell} height={cell}
              fill={color} fillOpacity={0.12} stroke={color} strokeWidth={2} strokeDasharray="6 4" /> : null,
            acc > 0 ? <Circle key={`${m.id}-a`} cx={left} cy={top} r={Math.min(acc, 1e5)} fill={color}
              fillOpacity={0.15} stroke={color} strokeOpacity={0.7} strokeWidth={1.5} /> : null,
          ])}
        </Svg>
      )}
      {placed.map(({ m, left, top, color, cell }) =>
        // A coarse (grid) location is an area, not a point: no dot in its middle, only its label.
        cell > 0 ? (
          <View key={m.id} pointerEvents="none" style={[styles.areaLabel, { left: left - 100, top: top - 11 }]}>
            <Text numberOfLines={1} style={[styles.label, { marginLeft: 0, color: t.text, backgroundColor: t.surface, borderColor: color, borderWidth: 1 }]}>
              {m.label}
            </Text>
          </View>
        ) : (
        <View key={m.id} pointerEvents="none" style={[styles.marker, { left: left - 9, top: top - 9 }]}>
          <View style={styles.dotBox}>
            {m.kind === 'sos' && (
              <Animated.View style={[styles.pulse, { borderColor: color, opacity: fade, transform: [{ scale }] }]} />
            )}
            <View style={[styles.dot, { backgroundColor: color, borderColor: t.surface }, styles[m.kind]]} />
          </View>
          <Text numberOfLines={1} style={[styles.label, { color: t.text, backgroundColor: t.surface }]}>{m.label}</Text>
        </View>
        ),
      )}
      <View
        ref={surface}
        style={[StyleSheet.absoluteFill, WEB_SURFACE]}
        {...pan.panHandlers}
        accessible
        accessibilityRole="image"
        accessibilityLabel="Karte"
        accessibilityValue={markers.length ? { text: markers.map((m) => m.label).join(', ') } : undefined}
        accessibilityHint={onPress ? 'Tippen, um einen Ort zu wählen' : undefined}
      />
      <View style={styles.controls}>
        <MapButton label="Hineinzoomen" disabled={!c || c.z >= MAX_ZOOM} onPress={() => zoomBy(1)} t={t}>
          <Text style={[styles.buttonText, { color: t.text }]}>+</Text>
        </MapButton>
        <MapButton label="Herauszoomen" disabled={!c || c.z <= MIN_ZOOM} onPress={() => zoomBy(-1)} t={t}>
          <Text style={[styles.buttonText, { color: t.text }]}>−</Text>
        </MapButton>
        <MapButton label="Auf Markierungen zentrieren" disabled={!markers.length} onPress={() => go(fit())} t={t}>
          <Svg width={20} height={20} viewBox="0 0 20 20" stroke={t.text} strokeWidth={2} fill="none">
            <Circle cx={10} cy={10} r={5} />
            <Line x1={10} y1={1} x2={10} y2={5} />
            <Line x1={10} y1={15} x2={10} y2={19} />
            <Line x1={1} y1={10} x2={5} y2={10} />
            <Line x1={15} y1={10} x2={19} y2={10} />
          </Svg>
        </MapButton>
      </View>
      <Pressable
        onPress={() => void Linking.openURL('https://www.openstreetmap.org/copyright').catch(() => {})}
        accessibilityRole="link"
        style={[styles.attribution, { backgroundColor: t.surface }]}
      >
        <Text style={[styles.attributionText, { color: t.textMuted }]}>© OpenStreetMap-Mitwirkende</Text>
      </Pressable>
    </View>
  );
}

function MapButton(p: { label: string; disabled: boolean; onPress: () => void; t: Theme; children: ReactNode }) {
  return (
    <Pressable
      onPress={p.onPress}
      disabled={p.disabled}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityState={{ disabled: p.disabled }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: pressed ? p.t.surfaceRaised : p.t.surface, borderColor: p.t.border, opacity: p.disabled ? 0.5 : 1 },
      ]}
    >
      {p.children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  map: { alignSelf: 'stretch', overflow: 'hidden', borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  tile: { position: 'absolute', width: 256, height: 256 }, // no border: it would shift the image
  tileImage: { width: 256, height: 256 },
  marker: { position: 'absolute', width: 200, flexDirection: 'row', alignItems: 'center' },
  areaLabel: { position: 'absolute', width: 200, alignItems: 'center' },
  dotBox: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
  me: { width: 18, height: 18, borderRadius: 9, borderWidth: 3 },
  friend: {},
  sos: { width: 16, height: 16, borderRadius: 8 },
  place: { width: 12, height: 12, borderRadius: 3 },
  destination: { borderRadius: 2, transform: [{ rotate: '45deg' }] },
  pulse: { position: 'absolute', width: 18, height: 18, borderRadius: 9, borderWidth: 2 },
  label: {
    marginLeft: 4, maxWidth: 170, fontSize: 12, fontWeight: '600',
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.sm, overflow: 'hidden',
  },
  controls: { position: 'absolute', top: 8, right: 8, gap: 6 },
  button: {
    width: TOUCH, height: TOUCH, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center',
  },
  buttonText: { fontSize: 24, fontWeight: '600', lineHeight: 28 },
  attribution: {
    position: 'absolute', right: 0, bottom: 0, paddingHorizontal: 6, paddingVertical: 2, borderTopLeftRadius: radius.sm, opacity: 0.9,
  },
  attributionText: { fontSize: 11 },
});
