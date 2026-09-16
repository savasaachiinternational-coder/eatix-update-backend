import { checkFrame, similarity, Observation } from './face-policy';

const face: Observation = {
  count: 1,
  embedding: Array(128).fill(1),
  score: 0.99,
  real: 0.99,
  live: 0.99,
  yaw: 0,
  pitch: 0,
  size: 180,
};
describe('camera face validation', () => {
  it('requires a single clear live face and a complete identity embedding', () => {
    expect(checkFrame(face, 'center')).toBeNull();
    for (const change of [
      { count: 0 },
      { count: 2 },
      { embedding: [] },
      { embedding: [NaN] },
      { score: 0.5 },
      { real: 0.1 },
      { live: 0.1 },
      { real: undefined },
      { yaw: NaN },
      { size: 50 },
    ]) {
      expect(checkFrame({ ...face, ...change }, 'center')).not.toBeNull();
    }
  });
  it('enforces the current pose, not just face presence', () => {
    expect(checkFrame(face, 'left')).not.toBeNull();
    expect(checkFrame({ ...face, yaw: 0.3 }, 'left')).toBeNull();
    expect(checkFrame({ ...face, yaw: -0.3 }, 'right')).toBeNull();
    expect(checkFrame({ ...face, yaw: -0.3 }, 'left')).not.toBeNull();
  });
  it('accepts model-recommended liveness scores with a clear detected face', () => {
    expect(
      checkFrame({ ...face, score: 0.85, real: 0.72, live: 0.96 }, 'center'),
    ).toBeNull();
    expect(checkFrame({ ...face, score: 0.79 }, 'center')).not.toBeNull();
    expect(
      checkFrame({ ...face, score: 0.85, real: 0.59 }, 'center'),
    ).not.toBeNull();
    expect(
      checkFrame({ ...face, score: 0.85, live: 0.59 }, 'center'),
    ).not.toBeNull();
  });
  it('lowers the liveness floor for turned poses in both directions equally', () => {
    expect(
      checkFrame({ ...face, yaw: 0.3, real: 0.45, live: 0.45 }, 'left'),
    ).toBeNull();
    expect(
      checkFrame({ ...face, yaw: -0.3, real: 0.45, live: 0.45 }, 'right'),
    ).toBeNull();
    expect(
      checkFrame({ ...face, yaw: 0, real: 0.59, live: 0.99 }, 'center'),
    ).not.toBeNull();
    expect(
      checkFrame({ ...face, yaw: 0.3, real: 0.3, live: 0.45 }, 'left'),
    ).not.toBeNull();
  });
  it('rejects malformed embeddings and distinguishes different descriptors', () => {
    expect(similarity(face.embedding, [...face.embedding])).toBe(1);
    expect(similarity(face.embedding, Array(128).fill(20))).toBe(0);
    expect(similarity(face.embedding, [1])).toBe(0);
    expect(similarity(face.embedding, Array(128).fill(NaN))).toBe(0);
  });
});
