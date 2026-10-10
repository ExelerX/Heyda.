import { distanceM } from './distance';
import type { LatLon, LocationFix } from './types';

/**
 * A named circular place, stored only on the owner's device.
 * Contacts never see the coordinates, only the name the owner picked.
 */
export interface Place {
  id: string;
  name: string;
  center: LatLon;
  radiusM: number;
}

export interface GeofenceEvent {
  type: 'arrive' | 'leave';
  placeId: string;
  at: number;
}

export interface GeofenceOptions {
  /** Extra distance beyond the radius before a "leave" fires, to absorb GPS jitter. */
  exitMarginM?: number;
  /** How long a device must stay inside before "arrive" fires, so driving past does not count. */
  minDwellMs?: number;
  /** Fixes less accurate than this are ignored entirely. */
  maxAccuracyM?: number;
}

interface PlaceState {
  initialized: boolean;
  inside: boolean;
  candidateSince?: number;
}

const DEFAULTS: Required<GeofenceOptions> = {
  exitMarginM: 50,
  minDwellMs: 60_000,
  maxAccuracyM: 200,
};

/**
 * Turns a stream of location fixes into arrive/leave events with hysteresis and dwell time.
 *
 * The first valid fix only establishes the starting state and never emits an event,
 * so opening the app at home does not announce "arrived home".
 */
export class GeofenceTracker {
  private readonly opts: Required<GeofenceOptions>;
  private places = new Map<string, Place>();
  private states = new Map<string, PlaceState>();

  constructor(places: Place[] = [], options: GeofenceOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.setPlaces(places);
  }

  setPlaces(places: Place[]): void {
    const next = new Map(places.map((p) => [p.id, p]));
    for (const id of this.states.keys()) {
      if (!next.has(id)) this.states.delete(id);
    }
    for (const id of next.keys()) {
      if (!this.states.has(id)) this.states.set(id, { initialized: false, inside: false });
    }
    this.places = next;
  }

  isInside(placeId: string): boolean {
    return this.states.get(placeId)?.inside ?? false;
  }

  /**
   * Records a transition the OS already detected (native region monitoring),
   * so conditions like "while I'm at home" stay correct. Returns false if nothing changed.
   */
  applyTransition(placeId: string, inside: boolean): boolean {
    const state = this.states.get(placeId);
    if (!state) return false;
    const changed = !state.initialized || state.inside !== inside;
    state.initialized = true;
    state.inside = inside;
    state.candidateSince = undefined;
    return changed;
  }

  update(fix: LocationFix): GeofenceEvent[] {
    const accuracy = fix.accuracyM ?? 0;
    if (!(accuracy <= this.opts.maxAccuracyM)) return [];

    const events: GeofenceEvent[] = [];
    for (const place of this.places.values()) {
      const state = this.states.get(place.id);
      if (!state) continue;
      const d = distanceM(fix, place.center);

      if (!state.initialized) {
        state.initialized = true;
        state.inside = d <= place.radiusM;
        continue;
      }

      if (!state.inside) {
        if (d <= place.radiusM) {
          state.candidateSince ??= fix.timestamp;
          if (fix.timestamp - state.candidateSince >= this.opts.minDwellMs) {
            state.inside = true;
            state.candidateSince = undefined;
            events.push({ type: 'arrive', placeId: place.id, at: fix.timestamp });
          }
        } else {
          state.candidateSince = undefined;
        }
      } else if (d > place.radiusM + Math.max(this.opts.exitMarginM, accuracy)) {
        state.inside = false;
        events.push({ type: 'leave', placeId: place.id, at: fix.timestamp });
      }
    }
    return events;
  }
}
