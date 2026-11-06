// Spring motion expressed as CSS `linear()` easing curves.
//
// A damped spring (the motion model iOS uses for icon shuffles and folders) is
// simulated once per preset and sampled into a `linear()` timing function, so
// both CSS transitions and the Web Animations API get spring motion with zero
// per-frame JavaScript.
export interface SpringPreset {
  easing: string;
  duration: number;
}

interface SpringParams {
  // Seconds for one undamped oscillation; lower = snappier.
  response: number;
  // 1 = critically damped (no overshoot); lower values bounce.
  dampingFraction: number;
}

function buildSpring({ response, dampingFraction }: SpringParams): SpringPreset {
  const stiffness = (2 * Math.PI / response) ** 2;
  const damping = 4 * Math.PI * dampingFraction / response;
  const dt = 1 / 600;
  const samples: number[] = [];
  let position = 0;
  let velocity = 0;
  let time = 0;
  let settledFor = 0;

  // Integrate until the spring has rested near 1 for a short while.
  while (time < 3) {
    const force = -stiffness * (position - 1) - damping * velocity;
    velocity += force * dt;
    position += velocity * dt;
    time += dt;
    samples.push(position);

    if (Math.abs(position - 1) < 0.001 && Math.abs(velocity) < 0.01) {
      settledFor += dt;
      if (settledFor > 0.03) {
        break;
      }
    } else {
      settledFor = 0;
    }
  }

  const points = 48;
  const stops: string[] = [];
  for (let index = 0; index <= points; index += 1) {
    const sample = samples[Math.min(samples.length - 1, Math.round((index / points) * (samples.length - 1)))];
    stops.push(String(Math.round((index === points ? 1 : sample) * 10000) / 10000));
  }

  return {
    easing: `linear(${stops.join(", ")})`,
    duration: Math.round(time * 1000)
  };
}

const supportsLinearEasing =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("transition-timing-function", "linear(0, 1)");

function preset(params: SpringParams, fallback: SpringPreset): SpringPreset {
  return supportsLinearEasing ? buildSpring(params) : fallback;
}

export const springs = {
  // Icons sliding aside to open a slot.
  shuffle: preset({ response: 0.34, dampingFraction: 0.84 }, { easing: "cubic-bezier(.2,.9,.25,1)", duration: 300 }),
  // Drop settle / layout reflow.
  settle: preset({ response: 0.38, dampingFraction: 0.86 }, { easing: "cubic-bezier(.16,1,.3,1)", duration: 340 }),
  // Icons flying into a folder cover.
  merge: preset({ response: 0.42, dampingFraction: 0.88 }, { easing: "cubic-bezier(.2,.86,.2,1)", duration: 380 }),
  // Folder plate / cover pop with a touch of bounce.
  pop: preset({ response: 0.36, dampingFraction: 0.64 }, { easing: "cubic-bezier(.2,1.3,.3,1)", duration: 420 }),
  // Folder panel opening from its icon.
  open: preset({ response: 0.42, dampingFraction: 0.8 }, { easing: "cubic-bezier(.16,.92,.18,1)", duration: 420 }),
  // Folder panel collapsing back into its icon.
  close: preset({ response: 0.34, dampingFraction: 0.95 }, { easing: "cubic-bezier(.22,.82,.2,1)", duration: 300 })
};

// Expose presets to CSS so stylesheet transitions share the same motion.
export function installSpringCssVariables(root: HTMLElement = document.documentElement) {
  for (const [name, spring] of Object.entries(springs)) {
    root.style.setProperty(`--spring-${name}`, spring.easing);
    root.style.setProperty(`--spring-${name}-duration`, `${spring.duration}ms`);
  }
}
