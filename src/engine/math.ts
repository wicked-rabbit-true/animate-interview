/**
 * Platform-agnostic math helpers.
 * Nothing in this file touches the DOM, so it ports unchanged to React Native / Skia / Reanimated.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;

export const vec = (x = 0, y = 0): Vec2 => ({ x, y });

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Frame-rate independent exponential smoothing.
 * Behaves identically at 30, 60 or 120 Hz because the blend factor is derived from dt.
 * `lambda` is the responsiveness (higher = snappier); roughly 1/lambda seconds to cover 63% of the gap.
 */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  target + (current - target) * Math.exp(-lambda * dt);

export const wrapAngle = (a: number): number => {
  const m = (a + Math.PI) % TAU;
  return (m < 0 ? m + TAU : m) - Math.PI;
};

/** Like `damp`, but takes the shortest way around the circle. */
export const dampAngle = (current: number, target: number, lambda: number, dt: number): number =>
  current + wrapAngle(target - current) * (1 - Math.exp(-lambda * dt));

export const easeInOutQuad = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

/**
 * Damped harmonic oscillator used for secondary motion (ears, squash & stretch).
 * Integrated with small semi-implicit Euler sub-steps so it stays stable at any frame rate.
 */
export class Spring {
  value = 0;
  velocity = 0;
  private readonly stiffness: number;
  private readonly damping: number;

  constructor(stiffness: number, damping: number) {
    this.stiffness = stiffness;
    this.damping = damping;
  }

  update(target: number, dt: number): number {
    const steps = Math.max(1, Math.ceil(dt * 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const accel = this.stiffness * (target - this.value) - this.damping * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/** Small deterministic PRNG so simulations are reproducible (handy for tests and replays). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
