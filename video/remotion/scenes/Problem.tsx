import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Background } from '../components/Background';
import { Caption } from '../components/Caption';
import { COLORS, WIDTH } from '../constants';
import { FONTS } from '../lib/fonts';
import { PROOF } from '../data/proof';

// 0–6s. An agent's output is just text — who made it, was it paid for?
export const Problem: React.FC = () => {
  const frame = useCurrentFrame();

  const textOpacity = interpolate(frame, [10, 30, 160, 180], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill>
      <Background />

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', top: -60 }}>
        <div
          style={{
            width: WIDTH * 0.56,
            opacity: textOpacity,
            background: COLORS.cardBg,
            border: `1px solid ${COLORS.line}`,
            borderRadius: 16,
            padding: '36px 44px',
            fontFamily: FONTS.mono,
            fontSize: 28,
            color: COLORS.fg2,
            lineHeight: 1.6,
            wordBreak: 'break-word',
          }}
        >
          {PROOF.output.text}
        </div>
      </AbsoluteFill>

      <Caption from={20} duration={90} size={68}>
        An agent&rsquo;s output is just text.
      </Caption>
      <Caption from={100} duration={80} size={68} accent>
        Who made it? Was it paid for?
      </Caption>
    </AbsoluteFill>
  );
};
