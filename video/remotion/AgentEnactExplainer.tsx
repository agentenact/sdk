import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { COLORS, SCENES } from './constants';
import { Problem } from './scenes/Problem';
import { Call } from './scenes/Call';
import { RecordScene } from './scenes/Record';
import { Verify } from './scenes/Verify';
import { Proof } from './scenes/Proof';

const PREMOUNT = 20;

export const AgentEnactExplainer: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      <Sequence from={SCENES.problem.from} durationInFrames={SCENES.problem.duration} premountFor={PREMOUNT}>
        <Problem />
      </Sequence>
      <Sequence from={SCENES.call.from} durationInFrames={SCENES.call.duration} premountFor={PREMOUNT}>
        <Call />
      </Sequence>
      <Sequence from={SCENES.record.from} durationInFrames={SCENES.record.duration} premountFor={PREMOUNT}>
        <RecordScene />
      </Sequence>
      <Sequence from={SCENES.verify.from} durationInFrames={SCENES.verify.duration} premountFor={PREMOUNT}>
        <Verify />
      </Sequence>
      <Sequence from={SCENES.proof.from} durationInFrames={SCENES.proof.duration} premountFor={PREMOUNT}>
        <Proof />
      </Sequence>
    </AbsoluteFill>
  );
};
