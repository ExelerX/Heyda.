import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuitGate, SaveRequests } from './save-request';

describe('SaveRequests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves once the UI answers with the id it was sent', async () => {
    const saves = new SaveRequests();
    const sent: number[] = [];
    let settled = false;
    const done = saves.request((id) => sent.push(id), 3000).then(() => {
      settled = true;
    });
    expect(sent).toHaveLength(1);
    saves.done(sent[0]! + 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    saves.done(sent[0]!);
    await done;
    expect(settled).toBe(true);
  });

  it('gives up after the timeout, so a hung UI never blocks quitting', async () => {
    const saves = new SaveRequests();
    let settled = false;
    const done = saves.request(() => {}, 3000).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(settled).toBe(true);
  });

  it('resolves at once when the request cannot be sent', async () => {
    const saves = new SaveRequests();
    await saves.request(() => {
      throw new Error('window gone');
    }, 60_000);
  });

  it('gives every request its own id; an answer counts once', async () => {
    const saves = new SaveRequests();
    const sent: number[] = [];
    const first = saves.request((id) => sent.push(id), 3000);
    const second = saves.request((id) => sent.push(id), 3000);
    expect(new Set(sent).size).toBe(2);
    saves.done(sent[0]!);
    saves.done(sent[0]!);
    await first;
    let secondDone = false;
    void second.then(() => (secondDone = true));
    await Promise.resolve();
    expect(secondDone).toBe(false);
    saves.done(sent[1]!);
    await second;
  });
});

describe('QuitGate', () => {
  it('holds the first quit until the UI saved, then lets it go ahead', async () => {
    const gate = new QuitGate();
    let finishSave: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((r) => (finishSave = r)));
    const quit = vi.fn();
    expect(gate.mayQuit(save, quit)).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    // Clicking "Beenden" again meanwhile waits for the same save.
    expect(gate.mayQuit(save, quit)).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    finishSave();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    // The quit it then starts goes ahead.
    expect(gate.mayQuit(save, quit)).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('quits even when saving failed', async () => {
    const gate = new QuitGate();
    const quit = vi.fn();
    expect(gate.mayQuit(() => Promise.reject(new Error('disk full')), quit)).toBe(false);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(gate.mayQuit(() => Promise.resolve(), quit)).toBe(true);
  });
});
