import React from 'react';
import { Composition } from 'remotion';
import { AgentEnactExplainer } from './AgentEnactExplainer';
import { DURATION_FRAMES, FPS, HEIGHT, WIDTH } from './constants';

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="AgentEnactExplainer"
      component={AgentEnactExplainer}
      durationInFrames={DURATION_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  </>
);
