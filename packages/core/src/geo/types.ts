/** A WGS84 coordinate in decimal degrees. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** A single location fix as delivered by the OS location service. */
export interface LocationFix extends LatLon {
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** Horizontal accuracy radius in meters (68% confidence on both platforms). */
  accuracyM?: number;
  /** Ground speed in m/s as reported by the OS, if any. Negative values mean unknown. */
  speedMps?: number;
}

export function isValidLatLon(p: LatLon): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lon >= -180 &&
    p.lon <= 180
  );
}
