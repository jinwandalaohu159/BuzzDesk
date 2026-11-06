// Pointer velocity over a short trailing window. Mouse events stop arriving
// when the pointer rests, so velocity is evaluated against "now" and decays to
// zero on its own instead of freezing at the last movement.
export interface PointerVelocity {
  vx: number;
  vy: number;
  speed: number;
}

const windowMs = 90;
const historyMs = 400;
const still: PointerVelocity = { vx: 0, vy: 0, speed: 0 };

export class PointerVelocityTracker {
  private samples: Array<{ t: number; x: number; y: number }> = [];

  record(x: number, y: number, now = performance.now()) {
    const samples = this.samples;
    samples.push({ t: now, x, y });
    const cutoff = now - historyMs;
    while (samples.length > 2 && samples[1].t < cutoff) {
      samples.shift();
    }
  }

  reset() {
    this.samples = [];
  }

  // px per ms
  velocity(now = performance.now()): PointerVelocity {
    const samples = this.samples;
    if (samples.length === 0) {
      return still;
    }

    const latest = samples[samples.length - 1];
    const cutoff = now - windowMs;
    let reference = samples[0];
    for (const sample of samples) {
      if (sample.t <= cutoff) {
        reference = sample;
      } else {
        break;
      }
    }

    if (reference === latest) {
      return still;
    }

    const elapsed = Math.max(now - reference.t, windowMs * 0.5);
    const vx = (latest.x - reference.x) / elapsed;
    const vy = (latest.y - reference.y) / elapsed;
    return { vx, vy, speed: Math.hypot(vx, vy) };
  }
}
