import { useTick } from '../../lib/store';

/** The current time; the screen re-renders at least every `ms` so relative times stay fresh. */
export function useNow(ms = 30_000): number {
  useTick(ms);
  return Date.now();
}
