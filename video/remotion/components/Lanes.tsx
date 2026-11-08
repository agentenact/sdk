import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS, WIDTH } from '../constants';
import { FONTS } from '../lib/fonts';

export const LANE_Y = [260, 430, 600, 770] as const;
export const LANE_X_START = 360;
export const LANE_X_END = 1840;
export const LANE_LABEL_X = 140;

export const LANE_LABELS = ['Client', 'Agent', 'Facilitator', 'Stellar ledger'];

// One horizontal lifeline with its label. `activeFrom`/`activeDuration` (in
// the scene's local frame) light up the node briefly when the lane is
// involved in a beat.
export const Lane: React.FC<{
  index: number;
  activeAt?: number;
  glow?: boolean;
}> = ({ index, activeAt, glow }) => {
  const frame = useCurrentFrame();
  const y = LANE_Y[index];

  // Rises to a peak on activation, then decays fully back to 0 — a brief
  // highlight, not a permanent state change (extrapolateRight would
  // otherwise clamp at the last breakpoint and leave the label lit forever).
  const pulse =
    activeAt === undefined
      ? 0
      : interpolate(frame, [activeAt - 4, activeAt + 6, activeAt + 60], [0, 1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });

  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: LANE_X_START,
          top: y,
          width: LANE_X_END - LANE_X_START,
          height: 1,
          background: COLORS.line,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: LANE_LABEL_X,
          top: y - 16,
          fontFamily: FONTS.mono,
          fontSize: 30,
          fontWeight: 500,
          color: pulse > 0.05 ? COLORS.accentBright : COLORS.fg3,
          transition: 'none',
        }}
      >
        {LANE_LABELS[index]}
      </div>
      {glow && pulse > 0.02 ? (
        <div
          style={{
            position: 'absolute',
            left: LANE_X_START - 10,
            top: y - 10,
            width: 20,
            height: 20,
            borderRadius: 20,
            background: COLORS.accent,
            opacity: pulse * 0.7,
            filter: 'blur(6px)',
          }}
        />
      ) : null}
    </>
  );
};

// A packet traveling vertically between two lanes at a fixed x, with a
// drawn-on connecting line and a small mono label.
export const Connector: React.FC<{
  x: number;
  fromLane: number;
  toLane: number;
  label: string;
  from: number; // local frame
  color?: string;
}> = ({ x, fromLane, toLane, label, from, color = COLORS.accent }) => {
  const frame = useCurrentFrame();
  const local = frame - from;
  if (local < -2) return null;

  const y1 = LANE_Y[fromLane];
  const y2 = LANE_Y[toLane];
  const top = Math.min(y1, y2);
  const height = Math.abs(y2 - y1);

  const draw = interpolate(local, [0, 22], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const packetT = interpolate(local, [4, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const labelOpacity = interpolate(local, [10, 24], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const packetY = y1 + (y2 - y1) * packetT;

  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: x - 1,
          top,
          width: 2,
          height: height * draw,
          background: color,
          opacity: 0.55,
        }}
      />
      {packetT > 0 && packetT < 1 ? (
        <div
          style={{
            position: 'absolute',
            left: x - 7,
            top: packetY - 7,
            width: 14,
            height: 14,
            borderRadius: 14,
            background: color,
            boxShadow: `0 0 18px 4px ${color}`,
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: x + 16,
          top: (y1 + y2) / 2 - 15,
          fontFamily: FONTS.mono,
          fontSize: 26,
          color: COLORS.fg2,
          opacity: labelOpacity,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
    </>
  );
};

// A self-contained pulse on one lane (e.g. "agent runs the work in memory").
export const NodePulse: React.FC<{ x: number; lane: number; label: string; from: number }> = ({
  x,
  lane,
  label,
  from,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const local = frame - from;
  if (local < -2) return null;

  const y = LANE_Y[lane];
  const ring = spring({ frame: local, fps, config: { damping: 200 }, durationInFrames: 30 });
  const opacity = interpolate(local, [0, 10, 55, 70], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{ position: 'absolute', left: x, top: y, opacity }}>
      <div
        style={{
          position: 'absolute',
          left: -18,
          top: -18,
          width: 36,
          height: 36,
          borderRadius: 36,
          border: `2px solid ${COLORS.accent}`,
          opacity: 0.5 * ring,
          transform: `scale(${0.6 + ring * 0.8})`,
        }}
      />
      <div
        style={{
          fontFamily: FONTS.mono,
          fontSize: 26,
          color: COLORS.fg2,
          transform: 'translate(20px, -14px)',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
    </div>
  );
};

// The one moment money moves: a block lands on the ledger lane.
export const SettleBlock: React.FC<{ x: number; from: number; amount: string; txRef: string }> = ({
  x,
  from,
  amount,
  txRef,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const local = frame - from;
  if (local < -2) return null;

  const y = LANE_Y[3];
  const scale = spring({ frame: local, fps, config: { damping: 12, mass: 0.6 }, durationInFrames: 24 });
  const opacity = interpolate(local, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const glowPulse = interpolate(local % 40, [0, 20, 40], [0.35, 0.75, 0.35]);

  return (
    <div
      style={{
        position: 'absolute',
        left: x - 175,
        top: y - 58,
        width: 350,
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      <div
        style={{
          borderRadius: 14,
          border: `1.5px solid ${COLORS.accentBright}`,
          background: COLORS.accentDim,
          boxShadow: `0 0 ${30 + glowPulse * 20}px ${glowPulse * 10}px ${COLORS.accentDim}`,
          padding: '18px 24px',
          textAlign: 'center',
        }}
      >
        <div style={{ fontFamily: FONTS.mono, fontSize: 22, color: COLORS.accentBright, letterSpacing: '0.06em' }}>
          SETTLED
        </div>
        <div style={{ fontFamily: FONTS.mono, fontSize: 34, fontWeight: 600, color: COLORS.fg, marginTop: 6 }}>
          {amount} USDC
        </div>
        <div style={{ fontFamily: FONTS.mono, fontSize: 28, color: COLORS.fg2, marginTop: 6 }}>{txRef}</div>
      </div>
    </div>
  );
};

export const laneBeatX = (beatIndex: number, totalBeats: number) => {
  const start = 420;
  const end = LANE_X_END - 60;
  return start + ((end - start) * beatIndex) / (totalBeats - 1);
};

export const WidthGuard = WIDTH;
