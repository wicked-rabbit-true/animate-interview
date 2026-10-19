# Creative Frontend Engineering Challenge: Interactive Pet Canvas

Welcome! The goal of this take-home challenge is to evaluate your skills in real-time browser graphics, asset rigging, and vector transformations using an HTML5 Canvas workspace.

## The Task
Inside this repository, you will find a boilerplate setup containing a canvas element, a high-performance `requestAnimationFrame` loop, and a primitive skeletal layout. 

Your objective is to replace the boilerplate primitive shapes with an optimized, real-time client-side layer where:
1. **Idle State:** The pet's body breathes or shifts subtly using basic 2D mesh deformation or sprite transformations inside the continuous render loop.
2. **Interactive Tracking:** The pet's head/eyes smoothly track a moving coordinate target (the user's cursor position).
3. **Action State (Fetch):** When the user clicks the "Play Fetch" button, animate a visual ball asset flying across the screen, and have the pet's structure stretch or move dynamically to intercept it.

## Technical Constraints & Expectations
- **Client-Side Only:** All rendering must happen in real-time on the client side. No server-side rendering or heavy AI video generation dependencies.
- **Performance:** Maintain a smooth, jank-free frame rate (60fps/120Hz compatible). Efficiently manage memory allocations and clear WebGL/Canvas states to prevent resource leaks.
- **Math/Physics:** Use programmatic easing and proper vector transformations (like Inverse Kinematics) rather than pre-baked CSS transitions.
- **Cross-Platform Readiness:** Keep your animation state calculations decoupled from specific DOM nodes so the core mathematical logic could theoretically be ported to a mobile context (e.g., React Native).

---

## Local Development Setup

To run this project locally, ensure you have **Node.js** installed, then execute the following commands in your terminal:

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Start Development Server:**
   ```bash
   npm run dev
   ```

3. **Open the App:**
   Click the local link generated in your terminal (typically `http://localhost:5173`) to view the interactive canvas live.

---

## Submission Guidelines

Please follow these exact steps to submit your completed assignment:

1. **Fork this repository** to your personal GitHub account.
2. Complete your code implementations within the `src/engine/` structure.
3. **Add detailed inline comments** or a brief markdown summary explaining your architecture choices, how you calculated the joint vectors, and your strategy for rendering smooth animations.
4. **Submit a link to your forked repository** directly to us on onlinejobs.

We look forward to seeing your creative approach!


---

## Solution notes

### Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build
```

Move the cursor to make the pet watch you. **Idle**, **Go for a walk** and **Play Fetch** switch behaviors. Press **D** to toggle a skeleton overlay (IK chains, joints, look target, fps).

### Architecture

```
src/engine/
  math.ts            vectors, frame-rate independent damping, springs, seeded RNG
  ik.ts              analytic two-bone IK (law of cosines), allocation free
  PetSimulation.ts   all behavior + skeleton + ball physics; outputs a plain-data PetPose
  PetRenderer.ts     Canvas2D drawing of a PetPose (no state)
  PetEngine.ts       pointer input + requestAnimationFrame loop, wires the two together
src/main.ts          UI (Tailwind) and button wiring
```

The simulation never touches the DOM. It takes `setCursor(x, y)`, `setBehavior(...)` and `update(dt)`, and exposes `pose`, a plain object of joint positions, angles and ball state. `PetRenderer` and `PetEngine` are the only browser-specific files. A React Native port (Skia or Reanimated) replaces those two and reuses `math`, `ik` and `PetSimulation` unchanged.

### How each requirement is met

- **Idle.** Breathing is a sine-driven chest/body scale with a small chest lift, plus slow weight sway of the hips. The feet stay planted because the legs are solved with IK against fixed foot targets. Ears are damped springs, the tail wags with a travelling wave, and the eyes blink at random intervals.
- **Cursor tracking.** The look target is exponentially damped toward the cursor. The head goal leans toward it inside a limited range, the neck is solved with two-bone IK, the head angle is clamped and damped, and the pupils ease independently. If the cursor stays behind the pet for a while, it turns around (the body mirror factor eases through zero).
- **Fetch.** The ball is launched with a velocity solved to land at a random spot, then bounces and rolls with real ballistic physics. The pet crouches, then runs to an intercept point found by forward-simulating the ball (including bounces) against its own run speed. The neck stretches up to 1.65x so the mouth can reach the ball, and it hops (squash and stretch, tucked legs) when the ball is high. After the catch it carries the ball back to the cursor, drops it, celebrates, and returns to idle.
- **Legs.** Four two-bone IK legs with a procedural gait. Feet are planted in world space. When a hip drifts too far, a diagonal pair takes an eased step with a lifted arc, while the other pair stays planted.

### Performance and memory

- No per-frame allocations in the simulation or renderer. Vectors are preallocated and IK writes into output objects.
- Time-step safe: `dt` is clamped, and the simulation splits long frames into at most 1/60 s sub-steps. Damping uses `exp(-lambda * dt)`, so motion looks the same at 30, 60 or 120 Hz.
- HiDPI aware backing store, kept in sync with CSS size through `ResizeObserver`. Pointer coordinates are mapped back into world units, so a CSS-scaled canvas still tracks correctly.
- `destroy()` cancels the animation frame and removes every listener (`AbortController`). The loop also pauses while the tab is hidden, and Vite HMR disposes the old engine.
