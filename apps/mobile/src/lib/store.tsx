import { contactLabel } from '@heyda/core';
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { registerBackgroundSync } from './background';
import { getRuntime, resetRuntime, type AppRuntime, type Snapshot } from './runtime';

interface RuntimeContextValue {
  runtime: AppRuntime;
  /** Rebuilds the runtime from storage, e.g. after switching demo mode, linking or restoring. */
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
      if (!r.isDemo) void registerBackgroundSync().catch(() => {});
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
      if (state === 'active') void runtime.tick();
      else void runtime.flush().catch(() => {});
    });
    return () => sub.remove();
  }, [runtime]);

  const restart = useCallback(async () => {
    const old = runtime;
    resetRuntime();
    setRuntime(undefined);
    await old?.shutdown(false).catch(() => {});
    await load();
  }, [load, runtime]);

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

/** Display name for a contact key (my nickname for them first), a group member, or "Jemand". */
export function useContactName(): (key: string) => string {
  const { state } = useSnapshot();
  return (key) => {
    if (key === 'any') return 'Jemand';
    if (key === state.self.key) return 'Ich';
    const c = state.contacts.find((x) => x.key === key);
    if (c) return contactLabel(c);
    for (const g of state.groups) {
      const m = g.members.find((x) => x.key === key);
      if (m) return m.name;
    }
    return 'Unbekannt';
  };
}

/** Name of a chat thread: a contact or a group ("g:" + id). */
export function useThreadName(): (thread: string) => string {
  const { state } = useSnapshot();
  const name = useContactName();
  return (thread) => (thread.startsWith('g:') ? state.groups.find((g) => `g:${g.id}` === thread)?.name ?? 'Gruppe' : name(thread));
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
