import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { COLORS } from '../constants';
import { FONTS } from '../lib/fonts';
import { PROOF } from '../data/proof';

// 54–60s (180 frames local). The real testnet tx hash, then the end card.
export const Proof: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const sceneOpacity = interpolate(frame, [0, 15, 165, 180], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const txOpacity = interpolate(frame, [10, 26, 100, 116], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const txY = interpolate(frame, [10, 26], [12, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const cardFrom = 96;
  const cardLocal = frame - cardFrom;
  const cardOpacity = interpolate(cardLocal, [0, 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const cardScale = spring({ frame: cardLocal, fps, config: { damping: 200 }, durationInFrames: 24 });

  return (
    <AbsoluteFill style={{ opacity: sceneOpacity }}>
      <Background />

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', top: -60, opacity: txOpacity, transform: `translateY(${txY}px)` }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: FONTS.mono, fontSize: 26, color: COLORS.fg3, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Stellar testnet · settlement
          </div>
          <div style={{ fontFamily: FONTS.mono, fontSize: 42, fontWeight: 600, color: COLORS.accentBright, marginTop: 10 }}>
            {PROOF.settlement.refShort}
          </div>
          <div style={{ fontFamily: FONTS.mono, fontSize: 22, color: COLORS.fg4, marginTop: 10 }}>
            {PROOF.settlement.amount} USDC · payer spent zero XLM
          </div>
        </div>
      </AbsoluteFill>

      {cardLocal >= 0 ? (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', opacity: cardOpacity, transform: `scale(${0.96 + cardScale * 0.04})` }}>
            <div style={{ fontFamily: FONTS.display, fontWeight: 700, fontSize: 96, color: COLORS.fg, letterSpacing: '-0.02em' }}>
              AgentEnact
            </div>
            <div style={{ fontFamily: FONTS.display, fontWeight: 500, fontSize: 34, color: COLORS.fg2, marginTop: 14 }}>
              provable agent outputs
            </div>
            <div style={{ fontFamily: FONTS.mono, fontSize: 32, color: COLORS.accent, marginTop: 28 }}>agentenact.srvl.app</div>
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
