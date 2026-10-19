/**
 * PetSimulation: the whole brain and skeleton of the pet.
 *
 * It has no DOM, canvas or browser dependencies. You feed it a cursor position, a behavior and a
 * time step; it produces a plain-data `PetPose` (joint positions, angles, ball state) that any
 * renderer can draw: Canvas2D today, React Native Skia / Reanimated tomorrow.
 *
 * Rig overview (world space, y down):
 *   - Body      : ellipse with breathing, sway, squash & stretch and pitch.
 *   - Legs (x4) : two-bone IK. Feet are planted in world space and take procedural steps
 *                 (diagonal pairs alternate) whenever the hips drift too far away.
 *   - Neck/head : two-bone IK with a stretchable neck, so the head can reach for the ball.
 *   - Tail      : forward-kinematic chain driven by a travelling sine wave.
 *   - Ears      : damped springs reacting to head velocity.
 *   - Eyes      : pupils ease toward the look target; random blinks.
 *
 * Every animated value uses frame-rate independent damping, springs or ballistic physics.
 * There are no CSS transitions or pre-baked clips.
 */

import { solveTwoBone } from './ik';
import {
  clamp,
  damp,
  dampAngle,
  easeInOutQuad,
  lerp,
  mulberry32,
  smoothstep,
  Spring,
  TAU,
  vec,
} from './math';
import type { Vec2 } from './math';

export type PetBehavior = 'idle' | 'walk' | 'fetch';
export type FetchPhase = 'none' | 'anticipate' | 'chase' | 'carry' | 'celebrate';

export const WORLD = { width: 600, height: 400, groundY: 338 } as const;
export const BODY = { rx: 50, ry: 28 } as const;
export const BALL_RADIUS = 10;
/** Mouth tip in head space (x forward, y down). */
export const MOUTH_OFFSET = { x: 34, y: 6 } as const;

const STAND_HEIGHT = 52;
const HIP_DROP = 16;
const REST_BODY_Y = WORLD.groundY - STAND_HEIGHT - HIP_DROP;
const LEG_UPPER = 32;
const LEG_LOWER = 32;
const NECK_UPPER = 24;
const NECK_LOWER = 24;
const SHOULDER = { x: 36, y: -12 } as const;
const TAIL_BASE = { x: -47, y: -8 } as const;
const TAIL_SEGMENTS = 5;
const TAIL_SEGMENT_LENGTH = 11;

const BALL_GRAVITY = 900;
const PET_GRAVITY = 1500;
const SPEED = { walk: 70, trot: 150, run: 235 } as const;
const MAX_SUBSTEP = 1 / 60;
const CATCH_STANDOFF = 50;

interface LegConfig {
  hipX: number;
  front: boolean;
  far: boolean;
  /** Diagonal gait pair: legs of the same pair swing together. */
  pair: 0 | 1;
}

const LEGS: readonly LegConfig[] = [
  { hipX: 30, front: true, far: false, pair: 0 }, // near front
  { hipX: -26, front: false, far: true, pair: 0 }, // far hind
  { hipX: 40, front: true, far: true, pair: 1 }, // far front
  { hipX: -36, front: false, far: false, pair: 1 }, // near hind
];

interface Mood {
  wagAmp: number;
  wagFreq: number;
  tailRaise: number;
  mouth: number;
  pant: number;
  breathRate: number;
  breathAmp: number;
}

const MOODS: Record<'idle' | 'walk' | 'chase' | 'carry' | 'celebrate', Mood> = {
  idle: { wagAmp: 0.4, wagFreq: 1.3, tailRaise: 0.55, mouth: 0, pant: 0, breathRate: 0.33, breathAmp: 0.03 },
  walk: { wagAmp: 0.5, wagFreq: 2.2, tailRaise: 0.5, mouth: 0.08, pant: 0, breathRate: 0.6, breathAmp: 0.035 },
  chase: { wagAmp: 0.7, wagFreq: 4, tailRaise: 0.2, mouth: 0.35, pant: 1, breathRate: 1.8, breathAmp: 0.06 },
  carry: { wagAmp: 0.6, wagFreq: 3, tailRaise: 0.4, mouth: 0, pant: 0, breathRate: 1, breathAmp: 0.045 },
  celebrate: { wagAmp: 1, wagFreq: 5.5, tailRaise: 0.6, mouth: 0.45, pant: 1, breathRate: 1.6, breathAmp: 0.055 },
};

/* ------------------------------------------------------------------ pose (render contract) */

export interface LegPose {
  hip: Vec2;
  joint: Vec2;
  foot: Vec2;
  far: boolean;
  front: boolean;
  stepping: boolean;
}

export interface BallPose {
  visible: boolean;
  carried: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  spin: number;
}

export interface PetPose {
  /** Horizontal mirror factor in [-1, 1]. Eases through 0 when the pet turns around. */
  facing: number;
  body: { x: number; y: number; rx: number; ry: number; sx: number; sy: number; angle: number };
  neck: { shoulder: Vec2; joint: Vec2; head: Vec2; stretch: number };
  head: {
    angle: number;
    mouthOpen: number;
    blink: number;
    /** Pupil offset in the unit disc, head space. */
    pupil: Vec2;
    earNear: number;
    earFar: number;
  };
  mouth: Vec2;
  legs: LegPose[];
  tail: Vec2[];
  ball: BallPose;
  shadow: { x: number; y: number; scale: number; alpha: number };
  lookTarget: Vec2;
  cursor: Vec2;
  behavior: PetBehavior;
  fetchPhase: FetchPhase;
}

function createPose(): PetPose {
  return {
    facing: 1,
    body: { x: 0, y: REST_BODY_Y, rx: BODY.rx, ry: BODY.ry, sx: 1, sy: 1, angle: 0 },
    neck: { shoulder: vec(), joint: vec(), head: vec(), stretch: 1 },
    head: { angle: 0, mouthOpen: 0, blink: 0, pupil: vec(), earNear: 0.2, earFar: 0.2 },
    mouth: vec(),
    legs: LEGS.map((c) => ({
      hip: vec(),
      joint: vec(),
      foot: vec(),
      far: c.far,
      front: c.front,
      stepping: false,
    })),
    tail: Array.from({ length: TAIL_SEGMENTS + 1 }, () => vec()),
    ball: { visible: false, carried: false, x: 0, y: 0, vx: 0, vy: 0, radius: BALL_RADIUS, alpha: 0, spin: 0 },
    shadow: { x: 0, y: WORLD.groundY + 3, scale: 1, alpha: 0.4 },
    lookTarget: vec(),
    cursor: vec(),
    behavior: 'idle',
    fetchPhase: 'none',
  };
}

/* ------------------------------------------------------------------ internal state types */

interface LegState {
  /** IK goal for the foot (planted position, or the swinging position mid-step). */
  foot: Vec2;
  from: Vec2;
  to: Vec2;
  stepping: boolean;
  t: number;
  dur: number;
  height: number;
}

interface BallKin {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface BallState extends BallKin {
  state: 'hidden' | 'flying' | 'carried';
  alpha: number;
  spin: number;
}

/** One ballistic step with bounce, rolling friction and wall bounce. Shared by the real ball and the predictor. */
function stepBall(b: BallKin, dt: number): void {
  b.vy += BALL_GRAVITY * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  const floor = WORLD.groundY - BALL_RADIUS;
  if (b.y >= floor) {
    b.y = floor;
    if (b.vy > 70) {
      b.vy = -b.vy * 0.55;
      b.vx *= 0.85;
    } else {
      b.vy = 0;
      b.vx *= Math.exp(-2.2 * dt);
      if (Math.abs(b.vx) < 2) b.vx = 0;
    }
  }
  if (b.x < BALL_RADIUS && b.vx < 0) {
    b.x = BALL_RADIUS;
    b.vx = -b.vx * 0.6;
  } else if (b.x > WORLD.width - BALL_RADIUS && b.vx > 0) {
    b.x = WORLD.width - BALL_RADIUS;
    b.vx = -b.vx * 0.6;
  }
}

/* ------------------------------------------------------------------ simulation */

export class PetSimulation {
  readonly pose: PetPose = createPose();
  /** Called whenever the active behavior changes (also when fetch ends by itself). */
  onBehaviorChange: ((behavior: PetBehavior) => void) | null = null;

  private readonly rng: () => number;
  private time = 0;

  // locomotion
  private x = WORLD.width * 0.5;
  private vx = 0;
  private desiredVx = 0;
  private lift = 0;
  private liftV = 0;
  private dirBlend = 1;
  private facingTarget = 1;
  private turnTimer = 0;

  // body
  private bodyX = this.x;
  private bodyY = REST_BODY_Y;
  private pitch = 0;
  private cosP = 1;
  private sinP = 0;
  private gait = 0;
  private breath = 0;
  private crouch = 0;
  private readonly squash = new Spring(240, 15);

  // behavior state
  private behavior: PetBehavior = 'idle';
  private readonly walk = { targetX: WORLD.width * 0.5, pause: 0 };
  private readonly fetch = { phase: 'none' as FetchPhase, t: 0, hops: 0 };
  private readonly cursor = vec(330, 180);
  private readonly look = vec(330, 180);

  // ball
  private readonly ball: BallState = { x: 0, y: 0, vx: 0, vy: 0, state: 'hidden', alpha: 0, spin: 0 };
  private readonly scratch: BallKin = { x: 0, y: 0, vx: 0, vy: 0 };
  private ballIdle = 0;

  // rig
  private readonly legs: LegState[] = LEGS.map(() => ({
    foot: vec(),
    from: vec(),
    to: vec(),
    stepping: false,
    t: 0,
    dur: 0.3,
    height: 8,
  }));
  private readonly swing: [number, number] = [0, 0];
  private readonly legErr: [number, number] = [0, 0];
  private readonly headLocal = vec(32, -30);
  private readonly reachPoint = vec();
  private readonly headGoal = vec();
  private reachActive = false;
  private reachBlend = 0;
  private neckStretch = 1;
  private headAngle = 0;
  private readonly prevHead = vec();
  private readonly headVel = vec();
  private readonly earNear = new Spring(150, 9);
  private readonly earFar = new Spring(120, 8);
  private blinkTimer = 2;
  private blinkT = -1;
  private tailPhase = 0;
  private readonly mood: Mood = { ...MOODS.idle };
  private moodTarget: Mood = MOODS.idle;

  constructor(seed = 1337) {
    this.rng = mulberry32(seed);

    // Put the feet under the hips, then run a short warm-up so the very first frame is a valid pose.
    this.updateBodyTransform(0);
    for (let i = 0; i < LEGS.length; i++) {
      this.toWorld(LEGS[i].hipX, HIP_DROP, this.pose.legs[i].hip);
      this.legs[i].foot.x = this.pose.legs[i].hip.x;
      this.legs[i].foot.y = WORLD.groundY;
    }
    for (let i = 0; i < 30; i++) this.step(1 / 60);
  }

  /* ------------------------------------------------------------------ public API */

  setCursor(x: number, y: number): void {
    this.cursor.x = clamp(x, -120, WORLD.width + 120);
    this.cursor.y = clamp(y, -120, WORLD.height + 120);
  }

  getBehavior(): PetBehavior {
    return this.behavior;
  }

  setBehavior(next: PetBehavior): void {
    if (next === this.behavior && next !== 'fetch') return;

    if (this.fetch.phase !== 'none') this.releaseBall();
    this.fetch.phase = 'none';
    this.behavior = next;

    if (next === 'walk') {
      this.walk.pause = 0;
      this.pickWalkTarget();
    } else if (next === 'fetch') {
      this.startFetch();
    }
    this.onBehaviorChange?.(next);
  }

  /** Advance the simulation. Large frames are split into <= 1/60 s sub-steps for stable physics. */
  update(dtSeconds: number): void {
    const dt = clamp(dtSeconds, 0, 0.1);
    if (dt <= 1e-6) return;
    const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP - 1e-6));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h);
  }

  /* ------------------------------------------------------------------ main step */

  private step(dt: number): void {
    this.time += dt;
    this.updateBall(dt);
    this.updateBehavior(dt);
    this.integrateBody(dt);
    this.updateBodyTransform(dt);
    this.updateLegs(dt);
    this.updateHead(dt);
    this.updateTail(dt);
    this.writePose();
  }

  /* ------------------------------------------------------------------ behaviors */

  private updateBehavior(dt: number): void {
    this.crouch = 0;
    this.reachActive = false;
    this.desiredVx = 0;
    let moodTarget: Mood = MOODS.idle;

    switch (this.behavior) {
      case 'idle':
        this.updateIdle(dt);
        break;
      case 'walk':
        moodTarget = this.updateWalk(dt);
        break;
      case 'fetch':
        moodTarget = this.updateFetch(dt);
        break;
    }
    this.moodTarget = moodTarget;

    // Where the eyes/head are looking: the flying ball while it matters, otherwise the cursor.
    const watchBall =
      this.behavior === 'fetch' &&
      (this.fetch.phase === 'anticipate' || this.fetch.phase === 'chase') &&
      this.ball.state === 'flying';
    const gx = watchBall ? this.ball.x : this.cursor.x;
    const gy = watchBall ? this.ball.y : this.cursor.y;
    this.look.x = damp(this.look.x, gx, 9, dt);
    this.look.y = damp(this.look.y, gy, 9, dt);

    const m = this.mood;
    const t = this.moodTarget;
    m.wagAmp = damp(m.wagAmp, t.wagAmp, 4, dt);
    m.wagFreq = damp(m.wagFreq, t.wagFreq, 4, dt);
    m.tailRaise = damp(m.tailRaise, t.tailRaise, 4, dt);
    m.mouth = damp(m.mouth, t.mouth, 5, dt);
    m.pant = damp(m.pant, t.pant, 5, dt);
    m.breathRate = damp(m.breathRate, t.breathRate, 3, dt);
    m.breathAmp = damp(m.breathAmp, t.breathAmp, 3, dt);
  }

  private updateIdle(dt: number): void {
    // Turn around if the cursor stays behind the pet for a while.
    const dx = this.cursor.x - this.x;
    if (dx * this.facingTarget < -90) {
      this.turnTimer += dt;
      if (this.turnTimer > 0.9) {
        this.facingTarget = -this.facingTarget;
        this.turnTimer = 0;
      }
    } else {
      this.turnTimer = 0;
    }
  }

  private updateWalk(dt: number): Mood {
    const w = this.walk;
    if (w.pause > 0) {
      w.pause -= dt;
      if (w.pause <= 0) this.pickWalkTarget();
      return MOODS.idle;
    }
    const dx = w.targetX - this.x;
    if (Math.abs(dx) < 4) {
      w.pause = 0.6 + this.rng() * 0.9;
      return MOODS.idle;
    }
    const dir = dx > 0 ? 1 : -1;
    this.facingTarget = dir;
    this.desiredVx = dir * SPEED.walk * clamp(Math.abs(dx) / 60, 0.25, 1);
    return MOODS.walk;
  }

  private pickWalkTarget(): void {
    let target = this.x;
    for (let i = 0; i < 12; i++) {
      target = 70 + this.rng() * (WORLD.width - 140);
      if (Math.abs(target - this.x) > 140) break;
    }
    this.walk.targetX = target;
    this.facingTarget = target >= this.x ? 1 : -1;
  }

  /* ------------------------------------------------------------------ fetch */

  private startFetch(): void {
    const b = this.ball;
    const fromLeft = this.x > WORLD.width / 2;
    const x0 = fromLeft ? -BALL_RADIUS * 1.6 : WORLD.width + BALL_RADIUS * 1.6;
    const y0 = 120 + this.rng() * 50;

    let landX = WORLD.width / 2;
    for (let i = 0; i < 12; i++) {
      landX = 120 + this.rng() * (WORLD.width - 240);
      if (Math.abs(landX - this.x) > 120) break;
    }
    // Solve the launch velocity so the ball lands on landX after T seconds.
    const T = 1.05 + this.rng() * 0.25;
    b.x = x0;
    b.y = y0;
    b.vx = (landX - x0) / T;
    b.vy = (WORLD.groundY - BALL_RADIUS - y0 - 0.5 * BALL_GRAVITY * T * T) / T;
    b.state = 'flying';
    b.alpha = 1;
    b.spin = 0;
    this.ballIdle = 0;

    this.fetch.phase = 'anticipate';
    this.fetch.t = 0;
    this.fetch.hops = 0;
    this.facingTarget = x0 < this.x ? -1 : 1;
  }

  private updateFetch(dt: number): Mood {
    const f = this.fetch;
    const b = this.ball;
    f.t += dt;

    switch (f.phase) {
      case 'anticipate': {
        this.crouch = -0.13;
        if (f.t >= 0.28) {
          f.phase = 'chase';
          f.t = 0;
          this.squash.velocity += 4; // spring out of the crouch
        }
        return MOODS.chase;
      }

      case 'chase': {
        if (b.state === 'flying') this.chaseBall();
        if (f.t > 10) this.finishFetch();
        return MOODS.chase;
      }

      case 'carry': {
        const ownerX = clamp(this.cursor.x, 70, WORLD.width - 70);
        const dx = ownerX - this.x;
        const gap = Math.abs(dx) - 85;
        if (Math.abs(dx) > 20) this.facingTarget = dx > 0 ? 1 : -1;
        if (gap > 0) {
          this.desiredVx = (dx > 0 ? 1 : -1) * SPEED.trot * clamp(gap / 60, 0.25, 1);
        } else if (f.t > 0.5) {
          this.startCelebrate();
        }
        if (f.t > 7) this.startCelebrate();
        return MOODS.carry;
      }

      case 'celebrate': {
        if (f.hops === 0 && f.t >= 0.1) {
          this.jump(34);
          f.hops = 1;
        } else if (f.hops === 1 && f.t >= 0.75) {
          this.jump(28);
          f.hops = 2;
        }
        if (f.t > 1.6) this.finishFetch();
        return MOODS.celebrate;
      }

      default:
        this.finishFetch();
        return MOODS.idle;
    }
  }

  /** Intercept: run to where the ball will be (including bounces), reach with the neck, jump if it is high. */
  private chaseBall(): void {
    const b = this.ball;
    const e = this.interceptX() - this.x;
    const dir = e >= 0 ? 1 : -1;
    if (Math.abs(e) > 25) this.facingTarget = dir;
    const gap = Math.abs(e) - CATCH_STANDOFF;
    this.desiredVx = gap > 0 ? dir * SPEED.run * clamp(gap / 60, 0.15, 1) : 0;

    const S = this.pose.neck.shoulder;
    const sx = b.x - S.x;
    const sy = b.y - S.y;
    if (sx * sx + sy * sy < 125 * 125) {
      this.reachActive = true;
      this.reachPoint.x = b.x + b.vx * 0.05;
      this.reachPoint.y = b.y + b.vy * 0.05;
    }

    const above = this.pose.mouth.y - b.y;
    if (
      this.lift === 0 &&
      this.liftV === 0 &&
      above > 45 &&
      above < 150 &&
      Math.abs(b.x - this.pose.mouth.x) < 75 &&
      b.vy > -80
    ) {
      this.jump(clamp(above - 35, 12, 72));
    }

    const dx = b.x - this.pose.mouth.x;
    const dy = b.y - this.pose.mouth.y;
    const r = BALL_RADIUS + 14;
    if (dx * dx + dy * dy < r * r) this.catchBall();
  }

  /** Forward-simulate the ball and return the first x the pet can reach in time at a catchable height. */
  private interceptX(): number {
    const s = this.scratch;
    const b = this.ball;
    s.x = b.x;
    s.y = b.y;
    s.vx = b.vx;
    s.vy = b.vy;
    const dtp = 1 / 30;
    let t = 0;
    for (let i = 0; i < 90; i++) {
      stepBall(s, dtp);
      t += dtp;
      if (Math.abs(s.x - this.x) <= SPEED.run * 0.8 * t + 14 && s.y > WORLD.groundY - 140) return s.x;
    }
    return s.x;
  }

  private catchBall(): void {
    this.ball.state = 'carried';
    this.fetch.phase = 'carry';
    this.fetch.t = 0;
    this.reachActive = false;
    this.squash.velocity -= 3.5; // chomp
  }

  private startCelebrate(): void {
    this.dropBall(this.dirBlend >= 0 ? 70 : -70, -140);
    this.fetch.phase = 'celebrate';
    this.fetch.t = 0;
    this.fetch.hops = 0;
  }

  private dropBall(vx: number, vy: number): void {
    const b = this.ball;
    if (b.state !== 'carried') return;
    b.state = 'flying';
    b.vx = vx;
    b.vy = vy;
    this.ballIdle = 0;
  }

  private releaseBall(): void {
    this.dropBall(this.dirBlend >= 0 ? 40 : -40, -60);
    this.ballIdle = 0;
  }

  private finishFetch(): void {
    this.releaseBall();
    this.fetch.phase = 'none';
    this.behavior = 'idle';
    this.onBehaviorChange?.('idle');
  }

  private updateBall(dt: number): void {
    const b = this.ball;
    if (b.state !== 'flying') return;
    stepBall(b, dt);
    b.spin += (b.vx / BALL_RADIUS) * dt;

    // A ball nobody is chasing fades away after a couple of seconds.
    if (this.fetch.phase === 'none') {
      this.ballIdle += dt;
      if (this.ballIdle > 2) {
        b.alpha -= dt / 0.6;
        if (b.alpha <= 0) {
          b.alpha = 0;
          b.state = 'hidden';
        }
      }
    }
  }

  /* ------------------------------------------------------------------ body */

  private jump(height: number): void {
    if (this.lift > 0 || this.liftV !== 0) return;
    this.liftV = Math.sqrt(2 * PET_GRAVITY * height);
    this.squash.velocity += 3.5; // stretch on take-off
  }

  private integrateBody(dt: number): void {
    // Don't run backwards while still turning around: speed follows how aligned we are with the new heading.
    const align = smoothstep(0.15, 0.85, this.dirBlend * this.facingTarget);
    const wantVx = this.desiredVx * align;
    const rate = Math.abs(wantVx) > Math.abs(this.vx) ? 5 : 8;
    this.vx = damp(this.vx, wantVx, rate, dt);
    this.x = clamp(this.x + this.vx * dt, 40, WORLD.width - 40);
    this.dirBlend = damp(this.dirBlend, this.facingTarget, 11, dt);

    if (this.lift > 0 || this.liftV > 0) {
      this.liftV -= PET_GRAVITY * dt;
      this.lift += this.liftV * dt;
      if (this.lift <= 0) {
        this.squash.velocity -= -this.liftV * 0.015; // landing squash scales with impact speed
        this.lift = 0;
        this.liftV = 0;
      }
    }
  }

  private updateBodyTransform(dt: number): void {
    const speedN = clamp(Math.abs(this.vx) / SPEED.run, 0, 1);
    const idleness = 1 - speedN;

    this.breath += dt * TAU * this.mood.breathRate;
    this.gait += Math.abs(this.vx) * dt * 0.05;
    const squash = clamp(this.squash.update(this.crouch, dt), -0.35, 0.3);

    const sway = this.lift > 0 ? 0 : Math.sin(this.time * 0.55) * 1.6 * idleness;
    const bob = Math.sin(this.gait * 2) * 1.4 * speedN;

    const pitchTarget = clamp(Math.abs(this.vx) * 0.0004, 0, 0.1) - clamp(this.liftV * 0.0006, -0.3, 0.3);
    this.pitch = damp(this.pitch, pitchTarget, 10, dt);
    this.cosP = Math.cos(this.pitch);
    this.sinP = Math.sin(this.pitch);

    this.bodyX = this.x + sway;
    this.bodyY = REST_BODY_Y - this.lift - squash * 16 + bob;

    const breathe = Math.sin(this.breath) * this.mood.breathAmp;
    const body = this.pose.body;
    body.sx = (1 - 0.7 * squash) * (1 - 0.5 * breathe);
    body.sy = (1 + squash) * (1 + breathe);
  }

  /** Body-local (forward space) -> world. Applies pitch, the facing mirror and the body position. */
  private toWorld(lx: number, ly: number, out: Vec2): void {
    out.x = this.bodyX + (lx * this.cosP - ly * this.sinP) * this.dirBlend;
    out.y = this.bodyY + lx * this.sinP + ly * this.cosP;
  }

  /* ------------------------------------------------------------------ legs (IK + procedural gait) */

  private updateLegs(dt: number): void {
    const pose = this.pose;
    const sgn = this.dirBlend >= 0 ? 1 : -1;
    const airborne = this.lift > 0.5;
    const speed = Math.abs(this.vx);
    const lead = clamp(this.vx * 0.12, -24, 24);
    const ground = WORLD.groundY;

    for (let i = 0; i < LEGS.length; i++) this.toWorld(LEGS[i].hipX, HIP_DROP, pose.legs[i].hip);

    if (airborne) {
      // Tuck the legs while jumping.
      for (let i = 0; i < LEGS.length; i++) {
        const l = this.legs[i];
        const hip = pose.legs[i].hip;
        l.stepping = false;
        l.foot.x = damp(l.foot.x, hip.x + sgn * (LEGS[i].front ? 18 : -20), 18, dt);
        l.foot.y = damp(l.foot.y, hip.y + (LEGS[i].front ? 30 : 36), 18, dt);
      }
    } else {
      this.swing[0] = 0;
      this.swing[1] = 0;

      // 1) advance swings in progress
      for (let i = 0; i < LEGS.length; i++) {
        const l = this.legs[i];
        const hip = pose.legs[i].hip;
        if (l.stepping) {
          l.t = Math.min(1, l.t + dt / l.dur);
          l.to.x = hip.x + lead; // keep the landing spot under the moving hip
          l.foot.x = lerp(l.from.x, l.to.x, easeInOutQuad(l.t));
          l.foot.y = ground - Math.sin(Math.PI * l.t) * l.height;
          if (l.t >= 1) {
            l.stepping = false;
            l.foot.x = l.to.x;
            l.foot.y = ground;
          } else {
            this.swing[LEGS[i].pair]++;
          }
        } else {
          l.foot.y = damp(l.foot.y, ground, 40, dt);
        }
      }

      // 2) start new steps: the diagonal pair with the largest error goes first, the other waits
      const thr = speed > 12 ? 13 - clamp(speed * 0.025, 0, 5) : 5;
      this.legErr[0] = 0;
      this.legErr[1] = 0;
      for (let i = 0; i < LEGS.length; i++) {
        const l = this.legs[i];
        if (l.stepping) continue;
        const err = Math.abs(l.foot.x - (pose.legs[i].hip.x + lead));
        const p = LEGS[i].pair;
        if (err > this.legErr[p]) this.legErr[p] = err;
      }
      const first = this.legErr[0] >= this.legErr[1] ? 0 : 1;
      for (let k = 0; k < 2; k++) {
        const p = k === 0 ? first : 1 - first;
        const err = this.legErr[p];
        if (err > thr && this.swing[p] === 0 && (this.swing[1 - p] === 0 || err > 30)) {
          for (let i = 0; i < LEGS.length; i++) {
            if (LEGS[i].pair !== p || this.legs[i].stepping) continue;
            const l = this.legs[i];
            l.stepping = true;
            l.t = 0;
            l.from.x = l.foot.x;
            l.from.y = l.foot.y;
            l.to.x = pose.legs[i].hip.x + lead;
            l.to.y = ground;
            l.dur = clamp(0.3 - speed * 0.0009, 0.11, 0.3);
            l.height = 8 + Math.min(speed * 0.04, 10);
            this.swing[p]++;
          }
        }
      }
    }

    // 3) solve IK for every leg
    for (let i = 0; i < LEGS.length; i++) {
      const lp = pose.legs[i];
      // Front legs bend backwards at the elbow, hind legs bend forwards at the stifle.
      const bend = LEGS[i].front ? sgn : -sgn;
      solveTwoBone(lp.hip, this.legs[i].foot, LEG_UPPER, LEG_LOWER, bend, lp.joint, lp.foot);
      lp.stepping = this.legs[i].stepping;
    }
  }

  /* ------------------------------------------------------------------ neck, head, ears, eyes */

  private updateHead(dt: number): void {
    const pose = this.pose;
    const neck = pose.neck;
    const sgn = this.dirBlend >= 0 ? 1 : -1;
    const speedN = clamp(Math.abs(this.vx) / SPEED.run, 0, 1);
    const S = neck.shoulder;

    // Breathing lifts the chest a little.
    this.toWorld(SHOULDER.x, SHOULDER.y - Math.sin(this.breath) * this.mood.breathAmp * 50, S);

    // Head goal relative to the shoulder (forward space): rest pose leaning toward the look target ...
    let tx = 32 + clamp((this.look.x - S.x) * sgn * 0.1, -6, 12);
    let ty = -30 + clamp((this.look.y - S.y) * 0.12, -10, 12) + Math.sin(this.gait * 2 + 1) * 1.5 * speedN;

    // ... blended with a reach pose that puts the *mouth* on the ball.
    this.reachBlend = damp(this.reachBlend, this.reachActive ? 1 : 0, 12, dt);
    let reachAngle = 0;
    if (this.reachBlend > 0.002) {
      const mx = (this.reachPoint.x - S.x) * sgn;
      const my = this.reachPoint.y - S.y;
      const a = clamp(Math.atan2(my + 30, Math.max(mx - 32, 4)), -0.9, 1.15);
      const rx = mx - (MOUTH_OFFSET.x * Math.cos(a) - MOUTH_OFFSET.y * Math.sin(a));
      const ry = my - (MOUTH_OFFSET.x * Math.sin(a) + MOUTH_OFFSET.y * Math.cos(a));
      tx = lerp(tx, rx, this.reachBlend);
      ty = lerp(ty, ry, this.reachBlend);
      reachAngle = a;
    }
    this.headLocal.x = damp(this.headLocal.x, tx, 16, dt);
    this.headLocal.y = damp(this.headLocal.y, ty, 16, dt);

    // The neck stretches when the goal is farther than its natural length.
    const need = Math.hypot(this.headLocal.x, this.headLocal.y);
    const stretchGoal = clamp((need / (NECK_UPPER + NECK_LOWER)) * 1.01, 1, 1.65);
    this.neckStretch = damp(this.neckStretch, stretchGoal, 14, dt);
    neck.stretch = this.neckStretch;

    const goal = this.headGoal;
    goal.x = S.x + this.headLocal.x * this.dirBlend;
    goal.y = S.y + this.headLocal.y;
    solveTwoBone(
      S,
      goal,
      NECK_UPPER * this.neckStretch,
      NECK_LOWER * this.neckStretch,
      -sgn,
      neck.joint,
      neck.head,
    );

    // Head orientation: look at the target, within a comfortable range.
    const H = neck.head;
    const lvx = (this.look.x - H.x) * sgn;
    const lvy = this.look.y - H.y;
    const lookAngle = clamp(Math.atan2(lvy, Math.max(lvx, 12)), -0.65, 0.7);
    this.headAngle = dampAngle(this.headAngle, lerp(lookAngle, reachAngle, this.reachBlend), 10, dt);
    const cA = Math.cos(this.headAngle);
    const sA = Math.sin(this.headAngle);

    // Mouth tip (world).
    pose.mouth.x = H.x + (MOUTH_OFFSET.x * cA - MOUTH_OFFSET.y * sA) * this.dirBlend;
    pose.mouth.y = H.y + MOUTH_OFFSET.x * sA + MOUTH_OFFSET.y * cA;

    // Pupils: direction to the look target in head space, eased.
    const hx = lvx * cA + lvy * sA;
    const hy = -lvx * sA + lvy * cA;
    const len = Math.hypot(hx, hy) || 1;
    const mag = smoothstep(0, 90, len);
    const head = pose.head;
    head.pupil.x = damp(head.pupil.x, (hx / len) * mag, 16, dt);
    head.pupil.y = damp(head.pupil.y, (hy / len) * mag, 16, dt);

    // Ears: springs driven by head velocity (they lag, flop and swing).
    const rawVx = (H.x - this.prevHead.x) / dt;
    const rawVy = (H.y - this.prevHead.y) / dt;
    this.headVel.x = damp(this.headVel.x, rawVx, 30, dt);
    this.headVel.y = damp(this.headVel.y, rawVy, 30, dt);
    this.prevHead.x = H.x;
    this.prevHead.y = H.y;
    const earTarget =
      0.2 + clamp(this.headVel.x * sgn * 0.0015, -0.2, 0.7) - clamp(this.headVel.y * 0.002, -0.5, 0.5);
    head.earNear = this.earNear.update(earTarget, dt);
    head.earFar = this.earFar.update(earTarget * 0.9 + 0.05, dt);

    // Blinking.
    this.blinkTimer -= dt;
    if (this.blinkT < 0 && this.blinkTimer <= 0) this.blinkT = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt / 0.16;
      if (this.blinkT >= 1) {
        this.blinkT = -1;
        this.blinkTimer = 1.8 + this.rng() * 3.8;
        head.blink = 0;
      } else {
        head.blink = Math.sin(Math.PI * this.blinkT);
      }
    }

    // Mouth: panting while running, wide open when about to catch, shut while carrying.
    const carrying = this.ball.state === 'carried';
    const pant = this.mood.pant * 0.18 * Math.sin(this.time * 16);
    const reachOpen = this.fetch.phase === 'chase' ? this.reachBlend * 0.6 : 0;
    head.mouthOpen = carrying ? 0 : clamp(this.mood.mouth + pant + reachOpen, 0, 1);
  }

  /* ------------------------------------------------------------------ tail */

  private updateTail(dt: number): void {
    const tail = this.pose.tail;
    const m = this.mood;
    this.tailPhase += dt * TAU * m.wagFreq;

    this.toWorld(TAIL_BASE.x, TAIL_BASE.y, tail[0]);
    // Forward space: angle PI points straight back; adding "raise" tilts it upward.
    let angle = Math.PI + m.tailRaise + this.pitch;
    for (let k = 0; k < TAIL_SEGMENTS; k++) {
      // Travelling wave: later segments swing more and lag behind.
      const weight = 0.4 + (0.6 * k) / (TAIL_SEGMENTS - 1);
      angle += m.wagAmp * 0.3 * Math.sin(this.tailPhase - k * 0.75) * weight;
      tail[k + 1].x = tail[k].x + Math.cos(angle) * TAIL_SEGMENT_LENGTH * this.dirBlend;
      tail[k + 1].y = tail[k].y + Math.sin(angle) * TAIL_SEGMENT_LENGTH;
    }
  }

  /* ------------------------------------------------------------------ output */

  private writePose(): void {
    const pose = this.pose;
    const b = this.ball;

    // A carried ball rides on the mouth.
    if (b.state === 'carried') {
      b.x = pose.mouth.x;
      b.y = pose.mouth.y;
      b.vx = 0;
      b.vy = 0;
    }

    pose.facing = this.dirBlend;
    pose.body.x = this.bodyX;
    pose.body.y = this.bodyY;
    pose.body.angle = this.pitch;

    const lift = this.lift;
    pose.shadow.x = this.bodyX;
    pose.shadow.scale = clamp(1 - lift / 220, 0.5, 1);
    pose.shadow.alpha = 0.4 * clamp(1 - lift / 260, 0.3, 1);

    const bp = pose.ball;
    bp.visible = b.state !== 'hidden';
    bp.carried = b.state === 'carried';
    bp.x = b.x;
    bp.y = b.y;
    bp.vx = b.vx;
    bp.vy = b.vy;
    bp.alpha = b.alpha;
    bp.spin = b.spin;

    pose.lookTarget.x = this.look.x;
    pose.lookTarget.y = this.look.y;
    pose.cursor.x = this.cursor.x;
    pose.cursor.y = this.cursor.y;
    pose.behavior = this.behavior;
    pose.fetchPhase = this.fetch.phase;
  }
}
