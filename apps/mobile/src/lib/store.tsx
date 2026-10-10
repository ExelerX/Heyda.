import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { registerGeofences } from './location';
import { getRuntime, resetRuntime, type AppRuntime, type Snapshot } from './runtime';

interface RuntimeContextValue {
  runtime: AppRuntime;
  /** Rebuilds the runtime from storage, e.g. after switching demo mode or wiping. */
  restart: () => Promise<void>;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function RuntimeProvider({
  children,
  loading,
  failed,
}: {
  children: ReactNode;
  loading: ReactNode;
  failed: (message: string, retry: () => void) => ReactNode;
}) {
  const [runtime, setRuntime] = useState<AppRuntime>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const r = await getRuntime();
      setRuntime(r);
      // Re-register on every start: Android forgets geofences after a reboot.
      if (!r.isDemo) void registerGeofences(r.getSnapshot().state.places).catch(() => {});
    } catch (e) {
      resetRuntime();
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!runtime) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void runtime.flush().catch(() => {});
    });
    return () => sub.remove();
  }, [runtime]);

  const restart = useCallback(async () => {
    resetRuntime();
    setRuntime(undefined);
    await load();
  }, [load]);

  if (error) return <>{failed(error, () => void load())}</>;
  if (!runtime) return <>{loading}</>;
  return <RuntimeContext.Provider value={{ runtime, restart }}>{children}</RuntimeContext.Provider>;
}

function useCtx(): RuntimeContextValue {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error('RuntimeProvider missing');
  return ctx;
}

export const useRuntime = (): AppRuntime => useCtx().runtime;
export const useRestart = (): (() => Promise<void>) => useCtx().restart;

export function useSnapshot(): Snapshot {
  const r = useRuntime();
  return useSyncExternalStore(r.subscribe, r.getSnapshot, r.getSnapshot);
}

/** Display name for a contact key, or a fallback for unknown keys. */
export function useContactName(): (key: string) => string {
  const { state } = useSnapshot();
  return (key) => (key === 'any' ? 'Jemand' : state.contacts.find((c) => c.key === key)?.name ?? 'Unbekannt');
}

/** Re-renders every `ms` so relative times ("vor 3 min") stay fresh. */
export function useTick(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
