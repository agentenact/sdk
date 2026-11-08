export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const DURATION_FRAMES = 1800; // 60s @ 30fps

// Near-black ground, achromatic neutrals with a slight indigo bias, one
// indigo accent, semantic green/gray for pass/skip. Sibling of AgentKarma's
// visual language, own accent value per spec.
export const COLORS = {
  bg: '#08090a',
  bgElev: '#0d0e11',
  fg: 'rgba(255, 255, 255, 0.95)',
  fg2: '#c7cad1',
  fg3: '#8a8f98',
  fg4: '#5b5f66',
  line: 'rgba(255, 255, 255, 0.10)',
  lineDim: 'rgba(255, 255, 255, 0.05)',
  cardBg: 'rgba(255, 255, 255, 0.03)',

  accent: '#8583ff',
  accentBright: '#a3a1ff',
  accentDim: 'rgba(133, 131, 255, 0.16)',
  accentFaint: 'rgba(133, 131, 255, 0.08)',

  pass: '#4ade80',
  passDim: 'rgba(74, 222, 128, 0.14)',
  skip: '#8a8f98',
  skipDim: 'rgba(138, 143, 152, 0.12)',
} as const;

// Hard cuts between scenes — each scene fades fully to bare background
// before the next begins (no cross-dissolve, no ghosting).
export const SCENES = {
  problem: { from: 0, duration: 180 }, //    0.0 –  6.0s
  call: { from: 180, duration: 720 }, //     6.0 – 30.0s
  record: { from: 900, duration: 360 }, //  30.0 – 42.0s
  verify: { from: 1260, duration: 360 }, // 42.0 – 54.0s
  proof: { from: 1620, duration: 180 }, //  54.0 – 60.0s
} as const;

// The call — 6 caption beats x 120 frames (4s each) inside the 720-frame scene.
export const CALL_BEATS = {
  request: { from: 0, duration: 120 },
  price: { from: 120, duration: 120 },
  sign: { from: 240, duration: 120 },
  verifyRun: { from: 360, duration: 120 },
  settle: { from: 480, duration: 120 },
  respond: { from: 600, duration: 120 },
} as const;

// Four lanes, top to bottom.
export const LANES = {
  client: 0,
  agent: 1,
  facilitator: 2,
  ledger: 3,
} as const;

export const SAFE_MARGIN = 96;
