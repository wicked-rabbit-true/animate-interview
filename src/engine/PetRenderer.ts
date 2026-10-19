/**
 * PetRenderer: draws a `PetPose` with Canvas2D. It owns no animation state.
 * Swapping this file for a Skia / WebGL / React Native renderer leaves the simulation untouched.
 *
 * The hot path allocates nothing per frame (no arrays, closures or Path2D objects).
 */

import { BODY, WORLD } from './PetSimulation';
import type { LegPose, PetPose } from './PetSimulation';

const TAU = Math.PI * 2;

const COLORS = {
  fur: '#d9a05b',
  furLight: '#f1cf9a',
  furDark: '#a96a35',
  furFar: '#b98040',
  paw: '#7a4a24',
  pawFar: '#5f3a1c',
  nose: '#1e1b2e',
  eyeWhite: '#fff7ea',
  pupil: '#1b1625',
  tongue: '#f0627f',
  mouth: '#5b2230',
  ball: '#d4e83a',
  ballSeam: '#f8fbe0',
  grid: 'rgba(148, 163, 184, 0.08)',
  groundTop: '#16233a',
  groundBottom: '#0f172a',
  groundLine: '#334155',
  label: '#7c8aa0',
};

const DASH: number[] = [4, 4];
const NO_DASH: number[] = [];

export interface RenderStats {
  debug: boolean;
  fps: number;
}

export class PetRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver | null;
  private scale = 1;
  private cssWidth: number = WORLD.width;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not available');
    this.canvas = canvas;
    this.ctx = ctx;

    this.cssWidth = canvas.clientWidth || WORLD.width;
    this.resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.measure()) : null;
    this.resizeObserver?.observe(canvas);
    this.syncBackingStore();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
  }

  render(pose: PetPose, stats: RenderStats): void {
    const ctx = this.ctx;
    this.syncBackingStore();
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.clearRect(0, 0, WORLD.width, WORLD.height);

    this.drawBackground();
    this.drawShadows(pose);
    this.drawTail(pose);
    this.drawLegs(pose, true);
    this.drawBody(pose);
    this.drawLegs(pose, false);
    this.drawNeck(pose);
    this.drawHead(pose);
    this.drawBall(pose);
    this.drawCursor(pose);
    this.drawHud(pose, stats);
    if (stats.debug) this.drawDebug(pose);
  }

  /* ------------------------------------------------------------------ sizing */

  private measure(): void {
    this.cssWidth = this.canvas.clientWidth || WORLD.width;
  }

  /** Keep the backing store crisp on HiDPI screens and when the canvas is scaled by CSS. */
  private syncBackingStore(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(this.cssWidth * dpr));
    const h = Math.max(1, Math.round((w * WORLD.height) / WORLD.width));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.scale = w / WORLD.width;
  }

  /* ------------------------------------------------------------------ scene */

  private drawBackground(): void {
    const ctx = this.ctx;
    const gy = WORLD.groundY;

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= WORLD.width; x += 50) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, gy);
    }
    for (let y = 0; y <= gy; y += 50) {
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD.width, y);
    }
    ctx.stroke();

    const g = ctx.createLinearGradient(0, gy, 0, WORLD.height);
    g.addColorStop(0, COLORS.groundTop);
    g.addColorStop(1, COLORS.groundBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, gy, WORLD.width, WORLD.height - gy);
    ctx.strokeStyle = COLORS.groundLine;
    ctx.beginPath();
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(WORLD.width, gy + 0.5);
    ctx.stroke();
  }

  private drawShadows(pose: PetPose): void {
    const ctx = this.ctx;
    const s = pose.shadow;
    ctx.fillStyle = `rgba(0,0,0,${s.alpha})`;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, BODY.rx * 1.05 * s.scale, 7 * s.scale, 0, 0, TAU);
    ctx.fill();

    const b = pose.ball;
    if (b.visible && !b.carried) {
      const height = Math.max(0, WORLD.groundY - b.radius - b.y);
      const k = Math.max(0.35, 1 - height / 260);
      ctx.fillStyle = `rgba(0,0,0,${0.35 * k * b.alpha})`;
      ctx.beginPath();
      ctx.ellipse(b.x, WORLD.groundY + 3, b.radius * 1.1 * k, 3 * k, 0, 0, TAU);
      ctx.fill();
    }
  }

  /* ------------------------------------------------------------------ pet parts */

  private drawTail(pose: PetPose): void {
    const ctx = this.ctx;
    const t = pose.tail;
    const n = t.length - 1;
    ctx.strokeStyle = COLORS.furDark;
    ctx.lineCap = 'round';
    for (let k = 0; k < n; k++) {
      ctx.lineWidth = 9 - (5 * k) / (n - 1);
      ctx.beginPath();
      ctx.moveTo(t[k].x, t[k].y);
      ctx.lineTo(t[k + 1].x, t[k + 1].y);
      ctx.stroke();
    }
  }

  private drawLegs(pose: PetPose, far: boolean): void {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const dir = pose.facing >= 0 ? 1 : -1;
    for (let i = 0; i < pose.legs.length; i++) {
      const leg: LegPose = pose.legs[i];
      if (leg.far !== far) continue;
      ctx.strokeStyle = far ? COLORS.furFar : COLORS.fur;
      ctx.lineWidth = 13;
      ctx.beginPath();
      ctx.moveTo(leg.hip.x, leg.hip.y);
      ctx.lineTo(leg.joint.x, leg.joint.y);
      ctx.stroke();
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(leg.joint.x, leg.joint.y);
      ctx.lineTo(leg.foot.x, leg.foot.y);
      ctx.stroke();

      ctx.fillStyle = far ? COLORS.pawFar : COLORS.paw;
      ctx.beginPath();
      ctx.ellipse(leg.foot.x + dir * 3, leg.foot.y - 1, 8, 4.5, 0, 0, TAU);
      ctx.fill();
    }
  }

  private drawBody(pose: PetPose): void {
    const ctx = this.ctx;
    const b = pose.body;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.scale(safeFacing(pose.facing), 1);
    ctx.rotate(b.angle);
    ctx.scale(b.sx, b.sy);

    ctx.beginPath();
    ctx.ellipse(0, 0, b.rx, b.ry, 0, 0, TAU);
    ctx.fillStyle = COLORS.fur;
    ctx.fill();

    ctx.save();
    ctx.clip();
    ctx.fillStyle = COLORS.furLight; // belly
    ctx.beginPath();
    ctx.ellipse(6, b.ry * 0.78, b.rx * 0.82, b.ry * 0.5, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = COLORS.furDark; // saddle
    ctx.beginPath();
    ctx.ellipse(-12, -b.ry * 0.62, b.rx * 0.55, b.ry * 0.42, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  private drawNeck(pose: PetPose): void {
    const ctx = this.ctx;
    const n = pose.neck;
    const width = 26 / Math.sqrt(n.stretch);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = COLORS.fur;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(n.shoulder.x, n.shoulder.y);
    ctx.lineTo(n.joint.x, n.joint.y);
    ctx.lineTo(n.head.x, n.head.y);
    ctx.stroke();
  }

  private drawHead(pose: PetPose): void {
    const ctx = this.ctx;
    const h = pose.head;
    const H = pose.neck.head;

    ctx.save();
    ctx.translate(H.x, H.y);
    ctx.scale(safeFacing(pose.facing), 1);
    ctx.rotate(h.angle);

    // far ear (behind the head)
    this.drawEar(5, -17, h.earFar, 0.85, COLORS.furDark);

    // mouth interior, tongue, lower jaw
    const open = h.mouthOpen;
    if (open > 0.04) {
      ctx.fillStyle = COLORS.mouth;
      ctx.beginPath();
      ctx.ellipse(20, 10, 14, 2 + open * 9, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = COLORS.tongue;
      ctx.beginPath();
      ctx.ellipse(18, 10 + open * 5, 7, 2.5 + open * 3, 0.1, 0, TAU);
      ctx.fill();
    }
    ctx.save();
    ctx.translate(8, 12);
    ctx.rotate(open * 0.55);
    ctx.fillStyle = COLORS.furDark;
    ctx.beginPath();
    ctx.ellipse(13, 0, 14, 5.5, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // skull + snout
    ctx.fillStyle = COLORS.fur;
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, TAU);
    ctx.fill();
    ctx.fillStyle = COLORS.furLight;
    ctx.beginPath();
    ctx.ellipse(22, 4, 15, 10, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = COLORS.nose;
    ctx.beginPath();
    ctx.ellipse(35, 0, 4.6, 3.8, 0, 0, TAU);
    ctx.fill();

    // eyes
    this.drawEye(4, -6, 6.2, h);
    this.drawEye(17, -8, 4.6, h);

    // near ear
    this.drawEar(-7, -14, h.earNear, 1, COLORS.furDark);

    ctx.restore();
  }

  private drawEar(x: number, y: number, angle: number, size: number, color: string): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, 12 * size, 7.5 * size, 14 * size, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  private drawEye(x: number, y: number, r: number, h: PetPose['head']): void {
    const ctx = this.ctx;
    const open = Math.max(0.08, 1 - h.blink);
    ctx.fillStyle = COLORS.eyeWhite;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * open, 0, 0, TAU);
    ctx.fill();
    if (open > 0.25) {
      ctx.fillStyle = COLORS.pupil;
      ctx.beginPath();
      ctx.ellipse(x + h.pupil.x * r * 0.42, y + h.pupil.y * r * 0.42 * open, r * 0.52, r * 0.52 * open, 0, 0, TAU);
      ctx.fill();
    }
  }

  /* ------------------------------------------------------------------ ball, cursor, HUD */

  private drawBall(pose: PetPose): void {
    const b = pose.ball;
    if (!b.visible || b.alpha <= 0) return;
    const ctx = this.ctx;
    const speed = Math.hypot(b.vx, b.vy);

    // short motion trail while the ball is moving fast
    if (speed > 150 && !b.carried) {
      for (let i = 2; i >= 1; i--) {
        ctx.globalAlpha = 0.12 * b.alpha * (3 - i);
        ctx.fillStyle = COLORS.ball;
        ctx.beginPath();
        ctx.arc(b.x - b.vx * 0.018 * i, b.y - b.vy * 0.018 * i, b.radius, 0, TAU);
        ctx.fill();
      }
    }

    ctx.globalAlpha = b.alpha;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.spin);
    ctx.fillStyle = COLORS.ball;
    ctx.beginPath();
    ctx.arc(0, 0, b.radius, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = COLORS.ballSeam;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(-b.radius * 1.1, 0, b.radius * 0.95, -0.9, 0.9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(b.radius * 1.1, 0, b.radius * 0.95, Math.PI - 0.9, Math.PI + 0.9);
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private drawCursor(pose: PetPose): void {
    const ctx = this.ctx;
    const c = pose.cursor;
    ctx.strokeStyle = pose.behavior === 'fetch' ? 'rgba(251,191,36,0.55)' : 'rgba(56,189,248,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 6, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 1.8, 0, TAU);
    ctx.fill();
  }

  private drawHud(pose: PetPose, stats: RenderStats): void {
    const ctx = this.ctx;
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = COLORS.label;
    const phase = pose.fetchPhase === 'none' ? '' : ` / ${pose.fetchPhase.toUpperCase()}`;
    ctx.fillText(`State: ${pose.behavior.toUpperCase()}${phase}`, 12, 10);
    if (stats.debug) ctx.fillText(`${Math.round(stats.fps)} fps`, 12, 26);
  }

  /** Skeleton overlay (press D): IK chains, joints, look target and mouth. */
  private drawDebug(pose: PetPose): void {
    const ctx = this.ctx;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'butt';

    for (let i = 0; i < pose.legs.length; i++) {
      const l = pose.legs[i];
      ctx.strokeStyle = '#22d3ee';
      ctx.beginPath();
      ctx.moveTo(l.hip.x, l.hip.y);
      ctx.lineTo(l.joint.x, l.joint.y);
      ctx.lineTo(l.foot.x, l.foot.y);
      ctx.stroke();
      dot(ctx, l.hip.x, l.hip.y, 2.5, '#a78bfa');
      dot(ctx, l.joint.x, l.joint.y, 2.5, '#facc15');
      dot(ctx, l.foot.x, l.foot.y, 3, l.stepping ? '#f43f5e' : '#34d399');
    }

    const n = pose.neck;
    ctx.strokeStyle = '#e879f9';
    ctx.beginPath();
    ctx.moveTo(n.shoulder.x, n.shoulder.y);
    ctx.lineTo(n.joint.x, n.joint.y);
    ctx.lineTo(n.head.x, n.head.y);
    ctx.stroke();
    dot(ctx, n.joint.x, n.joint.y, 2.5, '#facc15');
    dot(ctx, n.head.x, n.head.y, 3, '#e879f9');

    const t = pose.tail;
    ctx.strokeStyle = '#fb923c';
    ctx.beginPath();
    ctx.moveTo(t[0].x, t[0].y);
    for (let k = 1; k < t.length; k++) ctx.lineTo(t[k].x, t[k].y);
    ctx.stroke();

    ctx.setLineDash(DASH);
    ctx.strokeStyle = 'rgba(148,163,184,0.7)';
    ctx.beginPath();
    ctx.moveTo(n.head.x, n.head.y);
    ctx.lineTo(pose.lookTarget.x, pose.lookTarget.y);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    dot(ctx, pose.lookTarget.x, pose.lookTarget.y, 3, '#94a3b8');
    dot(ctx, pose.mouth.x, pose.mouth.y, 3, '#fb923c');
  }
}

function safeFacing(f: number): number {
  return Math.abs(f) < 0.02 ? (f < 0 ? -0.02 : 0.02) : f;
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}
