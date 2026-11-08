import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { Caption } from '../components/Caption';
import { COLORS, WIDTH } from '../constants';
import { FONTS } from '../lib/fonts';
import { PROOF } from '../data/proof';

const ROWS: { label: string; value: string }[] = [
  { label: 'agent · stellar', value: PROOF.agent.short },
  { label: 'input · sha256', value: PROOF.input.sha256Short },
  { label: 'output · sha256', value: PROOF.output.sha256Short },
  { label: 'settlement', value: `${PROOF.settlement.amount} USDC:${PROOF.settlement.assetIssuerShort}` },
  { label: 'payer', value: PROOF.settlement.payerShort },
  { label: 'issued at', value: PROOF.issuedAt.replace('.765Z', 'Z') },
];

const Row: React.FC<{ row: { label: string; value: string }; index: number }> = ({ row, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrom = 18 + index * 8;
  const s = spring({ frame: frame - localFrom, fps, config: { damping: 200 }, durationInFrames: 18 });
  const opacity = interpolate(s, [0, 1], [0, 1]);
  const x = interpolate(s, [0, 1], [-24, 0]);

  return (
    <div
      style={{
        opacity,
        transform: `translateX(${x}px)`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        padding: '14px 0',
        borderBottom: `1px solid ${COLORS.lineDim}`,
      }}
    >
      <div style={{ fontFamily: FONTS.mono, fontSize: 24, color: COLORS.fg3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {row.label}
      </div>
      <div style={{ fontFamily: FONTS.mono, fontSize: 30, color: COLORS.fg, fontWeight: 500 }}>{row.value}</div>
    </div>
  );
};

// 30–42s (360 frames local). Fields assemble into a card; a signature seals it.
export const RecordScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const sceneOpacity = interpolate(frame, [0, 15, 340, 360], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const cardScale = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 20 });

  const sealFrom = 130;
  const sealLocal = frame - sealFrom;
  const sealOpacity = interpolate(sealLocal, [0, 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const sealScale = spring({ frame: sealLocal, fps, config: { damping: 11, mass: 0.6 }, durationInFrames: 22 });

  return (
    <AbsoluteFill style={{ opacity: sceneOpacity }}>
      <Background tint="#10111a" />

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 96,
          textAlign: 'center',
          fontFamily: FONTS.display,
          fontWeight: 700,
          fontSize: 44,
          color: COLORS.fg,
        }}
      >
        The Enactment Record
      </div>

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', top: -20 }}>
        <div
          style={{
            width: WIDTH * 0.5,
            transform: `scale(${0.94 + cardScale * 0.06})`,
            opacity: cardScale,
            background: COLORS.cardBg,
            border: `1px solid ${COLORS.line}`,
            borderRadius: 20,
            padding: '38px 48px',
            position: 'relative',
          }}
        >
          {ROWS.map((row, i) => (
            <Row key={row.label} row={row} index={i} />
          ))}

          {sealLocal >= 0 ? (
            <div
              style={{
                position: 'absolute',
                right: -34,
                top: -34,
                opacity: sealOpacity,
                transform: `scale(${sealScale})`,
              }}
            >
              <div
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 96,
                  border: `2px solid ${COLORS.accentBright}`,
                  background: COLORS.accentDim,
                  boxShadow: `0 0 40px 6px ${COLORS.accentDim}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexDirection: 'column',
                }}
              >
                <div style={{ fontFamily: FONTS.mono, fontSize: 16, color: COLORS.accentBright, letterSpacing: '0.05em' }}>
                  ed25519
                </div>
                <div style={{ fontFamily: FONTS.mono, fontSize: 13, color: COLORS.fg3, marginTop: 2 }}>signed</div>
              </div>
            </div>
          ) : null}
        </div>
      </AbsoluteFill>

      <Caption from={20} duration={100} size={46} bottom={110}>
        One input, one output, one payment.
      </Caption>
      <Caption from={sealFrom + 6} duration={100} size={46} bottom={110} accent>
        Every field is signed together.
      </Caption>
    </AbsoluteFill>
  );
};
