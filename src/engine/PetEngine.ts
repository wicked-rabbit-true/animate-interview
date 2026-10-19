/**
 * PetAnimationEngine: the only DOM-aware piece besides the renderer.
 * It translates browser input into simulation calls and runs the requestAnimationFrame loop.
 *
 *   pointer events -> PetSimulation.setCursor / setBehavior
 *   rAF            -> PetSimulation.update(dt) -> PetRenderer.render(pose)
 *
 * A React Native port would replace this file (gesture handler + Reanimated frame callback)
 * and PetRenderer, and reuse PetSimulation / ik / math as-is.
 */

import { PetRenderer } from './PetRenderer';
import { PetSimulation, WORLD } from './PetSimulation';
import type { PetBehavior } from './PetSimulation';

export type { PetBehavior } from './PetSimulation';

export interface PetEngineOptions {
  /** Fires on every behavior change, including when fetch finishes and the pet returns to idle. */
  onBehaviorChange?: (behavior: PetBehavior) => void;
}

export class PetAnimationEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly sim: PetSimulation;
  private readonly renderer: PetRenderer;
  private readonly abort = new AbortController();
  private rafId: number | null = null;
  private last = 0;
  private fps = 60;
  private debug = false;

  constructor(canvas: HTMLCanvasElement, options: PetEngineOptions = {}) {
    this.canvas = canvas;
    this.sim = new PetSimulation();
    this.renderer = new PetRenderer(canvas);
    this.sim.onBehaviorChange = options.onBehaviorChange ?? null;

    const { signal } = this.abort;
    // Listen on the window so the pet keeps tracking when the pointer leaves the canvas.
    window.addEventListener('pointermove', this.onPointerMove, { signal, passive: true });
    window.addEventListener('keydown', this.onKeyDown, { signal });
    document.addEventListener('visibilitychange', this.onVisibility, { signal });

    this.last = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  setBehavior(behavior: PetBehavior): void {
    this.sim.setBehavior(behavior);
  }

  getBehavior(): PetBehavior {
    return this.sim.getBehavior();
  }

  toggleDebug(): void {
    this.debug = !this.debug;
  }

  /** Stops the loop and removes every listener. Safe to call more than once. */
  destroy(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.abort.abort();
    this.renderer.destroy();
  }

  private readonly frame = (now: number): void => {
    // Clamp huge gaps (tab switches, breakpoints) so physics never explodes.
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    this.sim.update(dt);
    this.renderer.render(this.sim.pose, { debug: this.debug, fps: this.fps });
    this.rafId = requestAnimationFrame(this.frame);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Map CSS pixels to world units so tracking stays correct when the canvas is scaled by CSS.
    this.sim.setCursor(
      ((e.clientX - rect.left) * WORLD.width) / rect.width,
      ((e.clientY - rect.top) * WORLD.height) / rect.height,
    );
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey) this.toggleDebug();
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
    } else if (this.rafId === null) {
      this.last = performance.now();
      this.rafId = requestAnimationFrame(this.frame);
    }
  };
}
