import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { COLORS, WIDTH } from '../constants';
import { FONTS } from '../lib/fonts';
import { PROOF } from '../data/proof';

type CheckStatus = 'pass' | 'skipped';

const CHECKS: { n: string; title: string; detail: string; status: CheckStatus; from: number }[] = [
  { n: '01', title: 'Signature', detail: 'the agent signed this record', status: PROOF.verification.checks.signature, from: 20 },
  {
    n: '02',
    title: 'Settlement',
    detail: `this tx paid ${PROOF.settlement.amount} USDC to this agent`,
    status: PROOF.verification.checks.settlement,
    from: 90,
  },
  {
    n: '03',
    title: 'Timing',
    detail: `issued ${PROOF.timingDeltaLabel} after settlement`,
    status: PROOF.verification.checks.timing,
    from: 160,
  },
  { n: '04', title: 'Identity', detail: 'skipped on testnet', status: PROOF.verification.checks.identity, from: 230 },
];

const CheckCard: React.FC<{ check: (typeof CHECKS)[number] }> = ({ check }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const local = frame - check.from;
  const s = spring({ frame: local, fps, config: { damping: 200 }, durationInFrames: 18 });
  const opacity = interpolate(s, [0, 1], [0, 1]);
  const y = interpolate(s, [0, 1], [16, 0]);
  const lit = local >= 0;

  const statusColor = check.status === 'pass' ? COLORS.pass : COLORS.skip;
  const statusDim = check.status === 'pass' ? COLORS.passDim : COLORS.skipDim;
  const statusLabel = check.status === 'pass' ? 'pass' : 'skipped';

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${y}px)`,
        display: 'flex',
        alignItems: 'center',
        gap: 28,
        width: WIDTH * 0.58,
        background: lit ? statusDim : 'transparent',
        border: `1px solid ${lit ? statusColor : COLORS.line}`,
        borderRadius: 14,
        padding: '20px 28px',
        marginBottom: 16,
      }}
    >
      <div style={{ fontFamily: FONTS.mono, fontSize: 30, color: COLORS.fg4, width: 48 }}>{check.n}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: FONTS.display, fontSize: 32, fontWeight: 600, color: COLORS.fg }}>{check.title}</div>
        <div style={{ fontFamily: FONTS.mono, fontSize: 22, color: COLORS.fg3, marginTop: 4 }}>{check.detail}</div>
      </div>
      <div
        style={{
          fontFamily: FONTS.mono,
          fontSize: 24,
          fontWeight: 600,
          color: statusColor,
          border: `1px solid ${statusColor}`,
          borderRadius: 8,
          padding: '6px 14px',
        }}
      >
        {statusLabel}
      </div>
    </div>
  );
};

// 42–54s (360 frames local). Four checks light up against public chain data,
// then the verdict. Identity is genuinely "skipped" on testnet — not a pass.
export const Verify: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const sceneOpacity = interpolate(frame, [0, 15, 340, 360], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const verdictFrom = 280;
  const verdictLocal = frame - verdictFrom;
  const verdictOpacity = interpolate(verdictLocal, [0, 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const verdictScale = spring({ frame: verdictLocal, fps, config: { damping: 200 }, durationInFrames: 20 });

  return (
    <AbsoluteFill style={{ opacity: sceneOpacity }}>
      <Background tint="#0d1410" />

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
        Verified against public chain data
      </div>

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', top: 10 }}>
        <div style={{ opacity: interpolate(frame, [260, 285], [1, 0.05], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
          {CHECKS.map((c) => (
            <CheckCard key={c.n} check={c} />
          ))}
        </div>
      </AbsoluteFill>

      {verdictLocal >= 0 ? (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div
            style={{
              opacity: verdictOpacity,
              transform: `scale(${0.9 + verdictScale * 0.1})`,
              textAlign: 'center',
              background: 'rgba(8, 9, 10, 0.88)',
              border: `1px solid ${COLORS.passDim}`,
              borderRadius: 24,
              padding: '32px 56px',
            }}
          >
            <div
              style={{
                fontFamily: FONTS.mono,
                fontSize: 96,
                fontWeight: 600,
                color: COLORS.pass,
                textShadow: `0 0 60px ${COLORS.passDim}`,
              }}
            >
              consistent: true
            </div>
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
