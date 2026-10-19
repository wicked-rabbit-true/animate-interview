import './style.css';
import { PetAnimationEngine } from './engine/PetEngine';
import type { PetBehavior } from './engine/PetEngine';
import { cn } from './lib/cn';

interface ActionButton {
  behavior: PetBehavior;
  label: string;
  /** Full class strings stay literal so Tailwind can see them. */
  idle: string;
  active: string;
}

const BUTTONS: ActionButton[] = [
  {
    behavior: 'idle',
    label: 'Idle',
    idle: 'bg-slate-800 text-slate-200 hover:bg-slate-700',
    active: 'bg-slate-600 text-white ring-2 ring-slate-300',
  },
  {
    behavior: 'walk',
    label: 'Go for a walk',
    idle: 'bg-sky-700 text-white hover:bg-sky-600',
    active: 'bg-sky-600 text-white ring-2 ring-sky-200',
  },
  {
    behavior: 'fetch',
    label: 'Play Fetch',
    idle: 'bg-amber-600 text-white hover:bg-amber-500',
    active: 'bg-amber-500 text-slate-950 ring-2 ring-amber-200',
  },
];

const BASE_BUTTON =
  'rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app container not found');

app.innerHTML = `
  <main class="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 p-6">
    <header class="text-center">
      <h1 class="text-2xl font-bold tracking-tight">Interactive Pet Canvas</h1>
      <p class="mt-1 text-sm text-slate-400">Move your cursor and the pet watches you. Press Play Fetch and it chases the ball.</p>
    </header>
    <canvas
      id="pet-canvas"
      width="600"
      height="400"
      role="img"
      aria-label="A dog that follows your cursor with its head and eyes, and chases a ball when you press Play Fetch"
      class="block aspect-[3/2] w-full max-w-[600px] cursor-crosshair rounded-xl border border-slate-800 bg-slate-900 shadow-lg"
    ></canvas>
    <div id="controls" class="flex flex-wrap justify-center gap-3"></div>
    <p class="text-xs text-slate-500">Press D to show the skeleton and IK debug overlay.</p>
  </main>
`;

const canvas = app.querySelector<HTMLCanvasElement>('#pet-canvas');
const controls = app.querySelector<HTMLDivElement>('#controls');
if (!canvas || !controls) throw new Error('UI failed to render');

const buttonEls = new Map<PetBehavior, HTMLButtonElement>();

function syncButtons(active: PetBehavior): void {
  for (const def of BUTTONS) {
    const el = buttonEls.get(def.behavior);
    if (!el) continue;
    el.className = cn(BASE_BUTTON, active === def.behavior ? def.active : def.idle);
    el.setAttribute('aria-pressed', String(active === def.behavior));
  }
}

const engine = new PetAnimationEngine(canvas, { onBehaviorChange: syncButtons });

for (const def of BUTTONS) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = def.label;
  el.addEventListener('click', () => engine.setBehavior(def.behavior));
  controls.appendChild(el);
  buttonEls.set(def.behavior, el);
}
syncButtons(engine.getBehavior());

// Vite HMR: tear the old engine down so reloads never stack up animation loops or listeners.
if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.destroy());
}
