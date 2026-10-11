/**
 * Web-Mercator ("slippy map") math for TileMap. Pure functions, no React Native.
 * World coordinates are normalised: x and y run from 0 to 1 across the whole map, independent
 * of zoom. At zoom z the world is 256 * 2^z pixels wide and has 2^z tiles per row.
 */
export const TILE_SIZE = 256;
export const MIN_ZOOM = 2;
export const MAX_ZOOM = 18;
const MAX_LAT = 85.0511287798; // where Web Mercator is square
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const RAD = Math.PI / 180;

export type WorldPoint = { x: number; y: number };
/** The world point in the middle of the view and an integer zoom. */
export type Camera = WorldPoint & { z: number };
export type TileRange = { z: number; x0: number; x1: number; y0: number; y1: number };
export type TileSlot = { key: string; url: string; left: number; top: number };

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z)));
export const worldSize = (z: number) => TILE_SIZE * 2 ** z;
export const wrap01 = (x: number) => x - Math.floor(x);
export const metersPerPixel = (lat: number, z: number) => (EARTH_CIRCUMFERENCE_M * Math.cos(lat * RAD)) / worldSize(z);

export function project(lat: number, lon: number): WorldPoint {
  const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * RAD;
  return { x: (lon + 180) / 360, y: (1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2 };
}

export function unproject(p: WorldPoint): { lat: number; lon: number } {
  return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * p.y))) / RAD, lon: wrap01(p.x) * 360 - 180 };
}

/** Index of the tile containing a coordinate (the classic OSM formula). */
export function tileAt(lat: number, lon: number, z: number): { x: number; y: number } {
  const p = project(lat, lon);
  const n = 2 ** z;
  return { x: Math.min(n - 1, Math.floor(wrap01(p.x) * n)), y: Math.min(n - 1, Math.floor(p.y * n)) };
}

/** Pixels from the view's top-left corner; uses the copy of the world nearest the centre. */
export function toScreen(p: WorldPoint, cam: Camera, w: number, h: number): { left: number; top: number } {
  const ws = worldSize(cam.z);
  const dx = p.x - cam.x;
  return { left: w / 2 + (dx - Math.round(dx)) * ws, top: h / 2 + (p.y - cam.y) * ws };
}

export function fromScreen(left: number, top: number, cam: Camera, w: number, h: number): WorldPoint {
  const ws = worldSize(cam.z);
  return { x: cam.x + (left - w / 2) / ws, y: cam.y + (top - h / 2) / ws };
}

/** Keeps x in [0, 1), the zoom in range, and the view from leaving the map at the poles. */
export function clampCamera(cam: Camera, h: number): Camera {
  const z = clampZoom(cam.z);
  const half = h / 2 / worldSize(z);
  return { x: wrap01(cam.x), y: half >= 0.5 ? 0.5 : Math.min(1 - half, Math.max(half, cam.y)), z };
}

/** Zooms by `dz` levels, keeping the point under (left, top) where it is. */
export function zoomAt(cam: Camera, dz: number, left: number, top: number, w: number, h: number): Camera {
  const z = clampZoom(cam.z + dz);
  if (z === cam.z) return cam;
  const p = fromScreen(left, top, cam, w, h);
  const ws = worldSize(z);
  return { x: p.x - (left - w / 2) / ws, y: p.y - (top - h / 2) / ws, z };
}

/** Tiles covering the view plus `margin` around it. x may leave [0, 2^z) (wrapped in tileSlots); y is clamped. */
export function tileRange(cam: Camera, w: number, h: number, margin = 1): TileRange {
  const n = 2 ** cam.z;
  const [cx, cy] = [cam.x * n * TILE_SIZE, cam.y * n * TILE_SIZE];
  return {
    z: cam.z,
    x0: Math.floor((cx - w / 2) / TILE_SIZE) - margin,
    x1: Math.floor((cx + w / 2) / TILE_SIZE) + margin,
    y0: Math.max(0, Math.floor((cy - h / 2) / TILE_SIZE) - margin),
    y1: Math.min(n - 1, Math.floor((cy + h / 2) / TILE_SIZE) + margin),
  };
}

/** Screen position of the range's top-left tile. */
export function rangeOrigin(r: TileRange, cam: Camera, w: number, h: number): { left: number; top: number } {
  const ws = worldSize(cam.z);
  return { left: r.x0 * TILE_SIZE - cam.x * ws + w / 2, top: r.y0 * TILE_SIZE - cam.y * ws + h / 2 };
}

/** One slot per tile of the range, positioned relative to the range origin. */
export function tileSlots(r: TileRange, template: string): TileSlot[] {
  const n = 2 ** r.z;
  const out: TileSlot[] = [];
  for (let ty = r.y0; ty <= r.y1; ty++) {
    for (let tx = r.x0; tx <= r.x1; tx++) {
      const x = String(((tx % n) + n) % n);
      const url = template.replace('{z}', String(r.z)).replace('{x}', x).replace('{y}', String(ty));
      out.push({ key: `${r.z}/${tx}/${ty}`, url, left: (tx - r.x0) * TILE_SIZE, top: (ty - r.y0) * TILE_SIZE });
    }
  }
  return out;
}

/** Closest view showing all points (and their radius in meters). One point: `singleZoom` unless its radius needs less. */
export function fitCamera(
  points: { lat: number; lon: number; radiusM?: number }[],
  w: number,
  h: number,
  { padding = 40, maxZoom = 16, singleZoom = 15 } = {},
): Camera | null {
  if (points.length === 0) return null;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    const c = project(p.lat, p.lon);
    const r = (p.radiusM ?? 0) / (EARTH_CIRCUMFERENCE_M * Math.max(0.01, Math.cos(p.lat * RAD)));
    [minX, maxX] = [Math.min(minX, c.x - r), Math.max(maxX, c.x + r)];
    [minY, maxY] = [Math.min(minY, c.y - r), Math.max(maxY, c.y + r)];
  }
  const [availW, availH] = [Math.max(1, w - 2 * padding), Math.max(1, h - 2 * padding)];
  let z = clampZoom(points.length === 1 ? singleZoom : maxZoom);
  while (z > MIN_ZOOM && ((maxX - minX) * worldSize(z) > availW || (maxY - minY) * worldSize(z) > availH)) z--;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z };
}
