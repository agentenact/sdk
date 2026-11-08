import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { COLORS, WIDTH } from '../constants';
import { FONTS } from '../lib/fonts';

// Large on-screen caption — carries the story since there is no voiceover.
// Fades + rises in, holds, fades out. `from`/`duration` are LOCAL frames
// (call from inside a <Sequence>).
export const Caption: React.FC<{
  children: React.ReactNode;
  from?: number;
  duration?: number;
  accent?: boolean;
  size?: number;
  bottom?: number;
}> = ({ children, from = 0, duration = 120, accent = false, size = 72, bottom = 140 }) => {
  const frame = useCurrentFrame();
  const local = frame - from;

  const opacity = interpolate(local, [0, 12, duration - 16, duration], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const rise = interpolate(local, [0, 16], [18, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  if (local < -1 || local > duration + 1) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom,
        display: 'flex',
        justifyContent: 'center',
        opacity,
        transform: `translateY(${rise}px)`,
      }}
    >
      <div
        style={{
          maxWidth: WIDTH * 0.78,
          textAlign: 'center',
          fontFamily: FONTS.display,
          fontWeight: 600,
          fontSize: size,
          lineHeight: 1.25,
          color: accent ? COLORS.accentBright : COLORS.fg,
          letterSpacing: '-0.01em',
          textShadow: '0 2px 24px rgba(0,0,0,0.5)',
        }}
      >
        {children}
      </div>
    </div>
  );
};
