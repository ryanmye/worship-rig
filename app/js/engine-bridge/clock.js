// Engine-time clock estimate for the JS side (contract 6.3). Native `tick` events carry engine time `t`; between ticks
// currentTime extrapolates with the page clock, capped at t_tick + CLOCK_CAP_SEC so a stalled native engine looks
// stalled to the controller watchdog (it compares successive reads, controller.js tick()). Never decreases, except
// once at the very first tick (see below).

export const CLOCK_CAP_SEC = 0.25;

export class EngineClock {
  /** @param {()=>number} now page clock in ms (performance.now) */
  constructor(now) {
    this.now = now;
    this.born = now();
    this.t = null; // engine time of the last tick
    this.perf = 0; // page time (ms) when that tick was received
    this.last = 0; // last value handed out
    this.preCap = Infinity; // before the first tick: free-run until start() is requested, then +CLOCK_CAP_SEC
    this.ticks = 0;
  }

  /** start() was requested but no tick has arrived: stop free-running so a dead engine is noticed. */
  startRequested() {
    if (this.t === null && this.preCap === Infinity) {
      this.preCap = (this.now() - this.born) / 1000 + CLOCK_CAP_SEC;
    }
  }

  /** @param {number} t engine time of the last rendered frame when the tick was produced */
  tick(t) {
    if (!Number.isFinite(t)) return;
    if (this.t === null) this.last = 0; // the free-run before the first tick was only a placeholder
    if (this.t === null || t >= this.t) {
      this.t = t;
      this.perf = this.now();
    }
    this.ticks += 1;
  }

  /** Estimated engine time now (s). */
  currentTime() {
    const p = this.now();
    let est;
    if (this.t === null) est = Math.min((p - this.born) / 1000, this.preCap);
    else est = this.t + Math.min(Math.max(0, p - this.perf) / 1000, CLOCK_CAP_SEC);
    if (est > this.last) this.last = est;
    return this.last;
  }

  /** `getOutputTimestamp()` shape: engine time that is audible at the page time of the last tick. */
  outputTimestamp(outputLatencySec = 0) {
    if (this.t === null) return { contextTime: 0, performanceTime: 0 };
    return { contextTime: this.t - outputLatencySec, performanceTime: this.perf };
  }
}
