export const FACE_MODEL = 'human-3.3.6-faceres';
export type Observation = {
  count: number;
  embedding?: number[];
  score?: number;
  real?: number;
  live?: number;
  yaw?: number;
  pitch?: number;
  size?: number;
};

export function validEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 64 &&
    value.length <= 2048 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    value.some((n) => n !== 0)
  );
}

// Human FaceRes similarity normalization, pinned to the model version above.
export function similarity(a: number[], b: number[]): number {
  if (!validEmbedding(a) || !validEmbedding(b) || a.length !== b.length)
    return 0;
  const sum = a.reduce((value, n, i) => value + (n - b[i]) ** 2, 0);
  return Math.max(0, Math.min(1, (1 - Math.sqrt(25 * sum) / 100 - 0.2) / 0.6));
}

export function instruction(direction: string): string {
  if (direction === 'left')
    return 'Slowly turn your head slightly to your left';
  if (direction === 'right')
    return 'Slowly turn your head slightly to your right';
  return 'Look straight at the camera and hold still';
}

export function checkFrame(
  face: Observation,
  direction: string,
): string | null {
  if (face.count !== 1)
    return face.count
      ? 'Only one person should be in the camera'
      : 'Look straight at the camera and hold still in the circle';
  if (
    !validEmbedding(face.embedding) ||
    // Detection quality is separate from the identity and liveness thresholds.
    // Use the same confidence floor as the face detector.
    !(face.score >= 0.8) ||
    !(face.size >= 100)
  )
    return 'Move closer and use brighter lighting';
  if (!(face.real >= 0.9) || !(face.live >= 0.9))
    return 'Use your live face in good lighting';
  if (
    !Number.isFinite(face.yaw) ||
    !Number.isFinite(face.pitch) ||
    Math.abs(face.pitch) > 0.3
  )
    return 'Keep your head level';
  const poseOK =
    direction === 'center'
      ? Math.abs(face.yaw) < 0.15
      : direction === 'left'
        ? face.yaw > 0.2 && face.yaw < 0.65
        : face.yaw < -0.2 && face.yaw > -0.65;
  return poseOK ? null : instruction(direction);
}
