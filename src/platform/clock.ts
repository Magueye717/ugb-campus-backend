/** Server time. Every business rule reads time from here so tests can move it. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Test clock: starts at a given instant and only moves when told to. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | number = Date.now()) {
    this.t = typeof start === 'number' ? start : start.getTime();
  }
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
  set(at: Date | number) {
    this.t = typeof at === 'number' ? at : at.getTime();
  }
}
