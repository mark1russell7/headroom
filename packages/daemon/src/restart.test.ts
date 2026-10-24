import { describe, expect, it } from "vitest";
import { IdleRestart } from "./restart.ts";

function fixture(waiting: number = 0): { idle: IdleRestart; restarts: () => number; setWaiting: (n: number) => void; setNow: (ms: number) => void } {
  let count = 0;
  let queue = waiting;
  let now = 1_000;
  const idle = new IdleRestart({ waiting: () => queue, restart: () => void count++, now: () => now });
  return {
    idle,
    restarts: () => count,
    setWaiting: (n) => void (queue = n),
    setNow: (ms) => void (now = ms),
  };
}

describe("IdleRestart", () => {
  it("does nothing when no restart waits", () => {
    const { idle, restarts } = fixture();
    expect(idle.tick()).toBe(false);
    expect(restarts()).toBe(0);
  });

  it("restarts at the first tick when no lease waits", () => {
    const { idle, restarts } = fixture();
    expect(idle.ask()).toEqual({ pending: { askedAt: 1_000 }, restarting: false, waiting: 0 });
    expect(idle.tick()).toBe(true);
    expect(restarts()).toBe(1);
    expect(idle.state()).toEqual({ pending: null, restarting: true, waiting: 0 });
  });

  it("does not restart while a lease waits, and restarts when the queue is empty", () => {
    const { idle, restarts, setWaiting } = fixture(2);
    expect(idle.ask().waiting).toBe(2);
    expect(idle.tick()).toBe(false);
    expect(idle.tick()).toBe(false);
    expect(restarts()).toBe(0);
    expect(idle.pending()).toEqual({ askedAt: 1_000 });
    setWaiting(0);
    expect(idle.tick()).toBe(true);
    expect(restarts()).toBe(1);
  });

  it("cancels a restart that waits", () => {
    const { idle, restarts, setWaiting } = fixture(1);
    idle.ask();
    expect(idle.cancel().pending).toBeNull();
    setWaiting(0);
    expect(idle.tick()).toBe(false);
    expect(restarts()).toBe(0);
  });

  it("keeps the time of the first request", () => {
    const { idle, setNow } = fixture(1);
    idle.ask();
    setNow(5_000);
    expect(idle.ask().pending).toEqual({ askedAt: 1_000 });
  });

  it("restarts one time, and ignores a request during the restart", () => {
    const { idle, restarts } = fixture();
    idle.ask();
    idle.tick();
    expect(idle.ask()).toEqual({ pending: null, restarting: true, waiting: 0 });
    expect(idle.tick()).toBe(false);
    expect(restarts()).toBe(1);
  });

  it("takes a new request after a restart that did not start", () => {
    const { idle, restarts } = fixture();
    idle.ask();
    idle.tick();
    idle.failed();
    expect(idle.ask().pending).not.toBeNull();
    expect(idle.tick()).toBe(true);
    expect(restarts()).toBe(2);
  });
});
