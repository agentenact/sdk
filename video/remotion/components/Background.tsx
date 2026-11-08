import React from 'react';
import { AbsoluteFill } from 'remotion';
import { COLORS } from '../constants';

// Radial gradient + noise + vignette — the safe default depth treatment.
// Noise is a low-opacity SVG feTurbulence layer (no image asset needed).
export const Background: React.FC<{ tint?: string }> = ({ tint }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 50% 40%, ${
            tint ?? COLORS.bgElev
          } 0%, ${COLORS.bg} 70%)`,
        }}
      />
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.035 }}>
        <filter id="noise">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter="url(#noise)" />
      </svg>
      <AbsoluteFill
        style={{
          boxShadow: 'inset 0 0 320px 80px rgba(0,0,0,0.55)',
        }}
      />
    </AbsoluteFill>
  );
};
