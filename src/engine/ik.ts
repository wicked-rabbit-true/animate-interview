import { clamp } from './math';
import type { Vec2 } from './math';

/**
 * Analytic two-bone IK (law of cosines).
 *
 * Given a fixed `root` (hip / shoulder) and a `target` (foot / head), finds the middle joint of a
 * two-segment chain with lengths `a` and `b`.
 *
 *  - `bend` (+1 / -1) picks which side of the root->target line the joint bulges to.
 *  - If the target is out of reach, the end effector is pulled back onto the reachable circle.
 *
 * Results are written into `joint` and `end`, so calling this every frame allocates nothing.
 */
export function solveTwoBone(
  root: Vec2,
  target: Vec2,
  a: number,
  b: number,
  bend: number,
  joint: Vec2,
  end: Vec2,
): void {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const base = Math.atan2(dy, dx);
  const d = clamp(Math.hypot(dx, dy), Math.abs(a - b) + 1e-3, a + b - 1e-3);

  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const angle = base + bend * Math.acos(cosA);

  joint.x = root.x + Math.cos(angle) * a;
  joint.y = root.y + Math.sin(angle) * a;
  end.x = root.x + Math.cos(base) * d;
  end.y = root.y + Math.sin(base) * d;
}
