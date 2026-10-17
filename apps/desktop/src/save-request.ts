// Asking the UI to save before the app goes away. Pure, unit-tested.
//
// The UI process holds the app's data and saves it itself, mostly in the background. Its page never
// counts as hidden (backgroundThrottling is off), so it cannot tell when the window went to the
// tray or the app is about to quit: the shell asks it (see `onSaveRequest` in the contract).

/** Save requests to the UI, each answered with its id. */
export class SaveRequests {
  private last = 0;
  private readonly waiting = new Map<number, () => void>();

  /**
   * Sends a request with `send`. Resolves once `done` was called with its id, or after `timeoutMs`:
   * a hung or crashed UI never holds anything up. Never rejects.
   */
  request(send: (id: number) => void, timeoutMs: number): Promise<void> {
    const id = ++this.last;
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.waiting.set(id, finish);
      try {
        send(id);
      } catch {
        finish();
      }
    });
  }

  /** The UI saved for request `id`. Unknown or already answered ids change nothing. */
  done(id: number): void {
    this.waiting.get(id)?.();
  }
}

/** Holds the first quit until the UI saved; quits asked for meanwhile wait for the same save. */
export class QuitGate {
  private state: 'open' | 'saving' | 'saved' = 'open';

  /**
   * For every quit attempt. True: it may go ahead now. False: hold it; `save` runs (once) and
   * `quit` is called when it is over, successful or not.
   */
  mayQuit(save: () => Promise<void>, quit: () => void): boolean {
    if (this.state === 'saved') return true;
    if (this.state === 'open') {
      this.state = 'saving';
      let saving: Promise<void>;
      try {
        saving = save();
      } catch {
        saving = Promise.resolve();
      }
      void saving
        .catch(() => undefined)
        .then(() => {
          this.state = 'saved';
          quit();
        });
    }
    return false;
  }
}
