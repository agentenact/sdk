import React from 'react';
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from 'remotion';
import { Background } from '../components/Background';
import { Caption } from '../components/Caption';
import { Connector, Lane, laneBeatX, LANE_X_END, LANE_X_START, NodePulse, SettleBlock } from '../components/Lanes';
import { CALL_BEATS, COLORS, LANES } from '../constants';
import { FONTS } from '../lib/fonts';
import { PROOF } from '../data/proof';

const BEAT_X = [0, 1, 2, 3, 4, 5].map((i) => laneBeatX(i, 6));

// 6–30s (720 frames local). One paid call: 402 -> pay -> verify -> run ->
// settle -> sign -> respond. Settlement is the one accent-colored moment.
export const Call: React.FC = () => {
  const frame = useCurrentFrame();

  const playheadX = interpolate(frame, [0, 720], [LANE_X_START, LANE_X_END], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const sceneOpacity = interpolate(frame, [0, 20, 700, 720], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ opacity: sceneOpacity }}>
      <Background tint="#0e0e18" />

      <div
        style={{
          position: 'absolute',
          left: 96,
          top: 110,
          fontFamily: FONTS.mono,
          fontSize: 26,
          letterSpacing: '0.1em',
          color: COLORS.fg4,
          textTransform: 'uppercase',
        }}
      >
        One paid call · Stellar testnet
      </div>

      {/* Playhead */}
      <div
        style={{
          position: 'absolute',
          left: playheadX,
          top: 220,
          width: 1,
          height: 610,
          background: COLORS.accent,
          opacity: 0.18,
        }}
      />

      {(() => {
        const laneActiveAt: Record<number, number> = {
          [LANES.client]: CALL_BEATS.request.from + 10,
          [LANES.agent]: CALL_BEATS.request.from + 40,
          [LANES.facilitator]: CALL_BEATS.sign.from + 50,
          [LANES.ledger]: CALL_BEATS.settle.from + 18,
        };
        return [0, 1, 2, 3].map((i) => <Lane key={i} index={i} glow activeAt={laneActiveAt[i]} />);
      })()}

      {/* Beat 1 — client calls agent */}
      <Sequence from={CALL_BEATS.request.from} durationInFrames={CALL_BEATS.request.duration} layout="none">
        <Connector x={BEAT_X[0]} fromLane={LANES.client} toLane={LANES.agent} label="GET /summarize" from={10} />
        <Caption from={20} duration={95} size={64}>
          Client calls the agent.
        </Caption>
      </Sequence>

      {/* Beat 2 — 402, price */}
      <Sequence from={CALL_BEATS.price.from} durationInFrames={CALL_BEATS.price.duration} layout="none">
        <Connector x={BEAT_X[1]} fromLane={LANES.agent} toLane={LANES.client} label="402 · $0.001 USDC" from={10} color={COLORS.fg3} />
        <Caption from={20} duration={95} size={64}>
          402: pay $0.001 USDC first.
        </Caption>
      </Sequence>

      {/* Beat 3 — client signs, zero XLM, facilitator sponsors */}
      <Sequence from={CALL_BEATS.sign.from} durationInFrames={CALL_BEATS.sign.duration} layout="none">
        <Connector
          x={BEAT_X[2]}
          fromLane={LANES.client}
          toLane={LANES.facilitator}
          label="sign auth entry · 0 XLM"
          from={10}
        />
        <Caption from={20} duration={95} size={64}>
          Client signs. Zero XLM.
        </Caption>
        <Caption from={20} duration={95} size={30} bottom={90} accent>
          the facilitator sponsors the fee
        </Caption>
      </Sequence>

      {/* Beat 4 — agent verifies with facilitator, then runs in memory */}
      <Sequence from={CALL_BEATS.verifyRun.from} durationInFrames={CALL_BEATS.verifyRun.duration} layout="none">
        <Connector x={BEAT_X[3]} fromLane={LANES.agent} toLane={LANES.facilitator} label="verify payment" from={6} />
        <NodePulse x={BEAT_X[3] + 40} lane={LANES.agent} label="running — in memory" from={55} />
        <Caption from={20} duration={95} size={64}>
          Agent verifies, then runs the work.
        </Caption>
      </Sequence>

      {/* Beat 5 — settle: the only moment money moves */}
      <Sequence from={CALL_BEATS.settle.from} durationInFrames={CALL_BEATS.settle.duration} layout="none">
        <SettleBlock x={BEAT_X[4]} from={8} amount={PROOF.settlement.amount} txRef={PROOF.settlement.refShort} />
        <Caption from={26} duration={90} size={72} accent>
          Money moves exactly once.
        </Caption>
      </Sequence>

      {/* Beat 6 — sign record, respond, client verifies */}
      <Sequence from={CALL_BEATS.respond.from} durationInFrames={CALL_BEATS.respond.duration} layout="none">
        <Connector x={BEAT_X[5]} fromLane={LANES.agent} toLane={LANES.client} label="record + output" from={8} />
        <Caption from={22} duration={95} size={60}>
          Agent signs the record. Client verifies it.
        </Caption>
      </Sequence>
    </AbsoluteFill>
  );
};
