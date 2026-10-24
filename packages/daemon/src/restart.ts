/**
 * The restart for an idle queue: `headroom service restart --when-idle` asks the daemon to restart itself at the first
 * tick when no lease waits. The daemon does the wait, because it is always active. A command that waits for a long time can
 * stop, for example when the low-memory guard of a session stops it.
 *
 * The request is in memory only. A daemon that stops for another reason forgets it.
 */

/** A restart that waits for an idle queue. */
export interface PendingRestart {
  /** The time of the request, in ms since the epoch. */
  readonly askedAt: number;
}

/** The state of the restart for an idle queue. */
export interface IdleRestartState {
  /** The restart that waits, or `null` when no restart waits. */
  readonly pending: PendingRestart | null;
  /** True: the restart started, and the daemon stops soon. */
  readonly restarting: boolean;
  /** The number of leases that wait. */
  readonly waiting: number;
}

/** The parts of an `IdleRestart`. A test gives fakes. */
export interface IdleRestartOptions {
  /** This function gives the number of leases that wait. */
  readonly waiting: () => number;
  /** This function starts the restart of the daemon. */
  readonly restart: () => void;
  /** This function gives the time in ms. The default is `Date.now`. */
  readonly now?: (() => number) | undefined;
}

/**
 * This class holds a restart that waits for an idle queue. The daemon uses `tick()` after each tick of the engine. The
 * granted leases do not stop the restart, because a new daemon keeps them.
 */
export class IdleRestart {
  readonly #options: IdleRestartOptions;
  #pending: PendingRestart | null = null;
  #restarting = false;

  constructor(options: IdleRestartOptions) {
    this.#options = options;
  }

  /** This function asks for a restart. A second request keeps the time of the first. It gives the state. */
  ask(): IdleRestartState {
    if (!this.#restarting && this.#pending === null) this.#pending = { askedAt: (this.#options.now ?? Date.now)() };
    return this.state();
  }

  /** This function cancels the restart that waits. It gives the state. */
  cancel(): IdleRestartState {
    this.#pending = null;
    return this.state();
  }

  /** This function gives the restart that waits, or `null`. */
  pending(): PendingRestart | null {
    return this.#pending;
  }

  /** This function gives the state. */
  state(): IdleRestartState {
    return { pending: this.#pending, restarting: this.#restarting, waiting: this.#options.waiting() };
  }

  /** This function starts the restart when one waits and no lease waits. It gives true when the restart starts. */
  tick(): boolean {
    if (this.#pending === null || this.#restarting || this.#options.waiting() > 0) return false;
    this.#pending = null;
    this.#restarting = true;
    this.#options.restart();
    return true;
  }

  /** This function records that the restart did not start, so a new request can start one. */
  failed(): void {
    this.#restarting = false;
  }
}
