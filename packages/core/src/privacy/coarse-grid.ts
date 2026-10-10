import { EARTH_RADIUS_M } from '../geo/distance';
import type { LatLon } from '../geo/types';

const M_PER_DEG_LAT = (Math.PI * EARTH_RADIUS_M) / 180;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export interface GridCell extends LatLon {
  /** Stable id, identical for every point in the cell. */
  id: string;
  cellM: number;
}

export const DEFAULT_CELL_M = 2000;

function cellGeometry(row: number, cellM: number) {
  const dLat = cellM / M_PER_DEG_LAT;
  const centerLat = -90 + (row + 0.5) * dLat;
  // Longitude width is fixed per row (taken at the row's centre), so the grid never moves.
  const cos = Math.max(0.01, Math.cos(toRad(centerLat)));
  const dLon = cellM / (M_PER_DEG_LAT * cos);
  return { dLat, dLon, centerLat };
}

/**
 * Snaps a point to the centre of a fixed grid cell.
 *
 * A fixed grid is used on purpose instead of random noise: averaging many noisy
 * reports converges on the true position, while every report from inside one
 * cell is identical and reveals nothing more.
 */
export function snapToGrid(p: LatLon, cellM: number = DEFAULT_CELL_M): GridCell {
  if (!(cellM >= 100)) throw new RangeError('cellM must be at least 100 m');
  const dLatProbe = cellM / M_PER_DEG_LAT;
  const row = Math.floor((p.lat + 90) / dLatProbe);
  const { dLon, centerLat } = cellGeometry(row, cellM);
  const col = Math.floor((p.lon + 180) / dLon);
  const centerLon = -180 + (col + 0.5) * dLon;
  return { id: `${cellM}:${row}:${col}`, lat: centerLat, lon: centerLon, cellM };
}

/**
 * Emits a new cell only after the device is clearly inside it, so walking along a
 * cell border does not flip back and forth and give the border's position away.
 */
export class CoarseLocator {
  private current: GridCell | undefined;

  constructor(
    private readonly cellM: number = DEFAULT_CELL_M,
    private readonly marginM: number = cellM * 0.15,
  ) {}

  get cell(): GridCell | undefined {
    return this.current;
  }

  /** Returns the new cell when it changed, otherwise `undefined`. */
  update(p: LatLon): GridCell | undefined {
    if (!this.current) {
      this.current = snapToGrid(p, this.cellM);
      return this.current;
    }
    const c = this.current;
    const dy = (p.lat - c.lat) * M_PER_DEG_LAT;
    const dx = (p.lon - c.lon) * M_PER_DEG_LAT * Math.cos(toRad(c.lat));
    const limit = this.cellM / 2 + this.marginM;
    if (Math.abs(dx) <= limit && Math.abs(dy) <= limit) return undefined;
    const next = snapToGrid(p, this.cellM);
    if (next.id === c.id) return undefined;
    this.current = next;
    return next;
  }
}
