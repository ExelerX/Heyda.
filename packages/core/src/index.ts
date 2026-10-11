export * from './geo/types';
export * from './geo/distance';
export * from './geo/geofence';
export * from './geo/parse-location';
export * from './eta/estimator';
export * from './privacy/levels';
export * from './privacy/eta-rounding';
export * from './privacy/coarse-grid';
export * from './privacy/policy';
export * from './protocol/messages';
export * from './protocol/compose';
export * from './transport/transport';
export * from './transport/memory';
export * from './session/session';
export * from './session/trip';
export * from './pairing/invite';
export * from './automation/schema';
export * from './automation/engine';
export * from './automation/templates';
export * from './automation/plugin';
export * from './automation/describe';
export * from './notify/prefs';
export * from './features/live';
export * from './features/labels';
export * from './sync/xfer';
export * from './sync/link';
export * from './sync/doc';
export * from './sync/receiver';
export * from './backup/backup';
export * from './util/rate-limit';
export * from './state';
export * from './node';
export { randomId } from './util/random';
export { base64urlDecode, base64urlEncode } from './util/base64url';

import { z } from 'zod';
/**
 * Turns off zod's eval-based fast path. Call once at startup in apps that run under a strict
 * Content Security Policy (the Windows app), so no `new Function` is ever attempted.
 */
export function enableStrictRuntime(): void {
  z.config({ jitless: true });
}
