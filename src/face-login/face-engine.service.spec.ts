import sharp from 'sharp';
import { dirname, join } from 'path';
import { FaceEngineService } from './face-engine.service';
import { similarity } from './face-policy';

// Exercise the real packaged models, including their non-terminal embedding output.
// The input is the library's own bundled demo screenshot, not user biometric data.
describe('packaged face recognition engine', () => {
  let engine: FaceEngineService;
  beforeEach(() => {
    engine = new FaceEngineService();
  });
  afterEach(() => engine.onModuleDestroy());

  it.each([
    [360, 640],
    [640, 360],
    [400, 700],
  ])(
    'detects a face in a %i x %i camera frame without stretching it',
    async (width, height) => {
      const sample = join(
        dirname(require.resolve('@vladmandic/human')),
        '../assets/screenshot-faceid.jpg',
      );
      const face = await sharp(sample)
        .extract({ left: 14, top: 142, width: 140, height: 140 })
        .resize(300, 300)
        .jpeg()
        .toBuffer();
      const frame = await sharp({
        create: { width, height, channels: 3, background: '#333333' },
      })
        .composite([{ input: face, gravity: 'center' }])
        .jpeg()
        .toBuffer();
      const result = await engine.analyze(frame);
      expect(result.count).toBe(1);
      expect(result.embedding).toHaveLength(1024);
      expect(result.embedding.every(Number.isFinite)).toBe(true);
    },
    30000,
  );

  it('extracts a finite identity descriptor, rejects invalid input and recovers', async () => {
    const sample = join(
      dirname(require.resolve('@vladmandic/human')),
      '../assets/screenshot-faceid.jpg',
    );
    const image = await sharp(sample)
      .extract({ left: 14, top: 142, width: 140, height: 140 })
      .resize(400, 400)
      .jpeg()
      .toBuffer();
    const first = await engine.analyze(image);
    expect(first.count).toBe(1);
    expect(first.embedding).toHaveLength(1024);
    expect(first.embedding.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(first.real)).toBe(true);
    expect(Number.isFinite(first.live)).toBe(true);
    await expect(engine.analyze(Buffer.from('not an image'))).rejects.toThrow(
      'Could not read',
    );
    const second = await engine.analyze(image);
    expect(similarity(first.embedding, second.embedding)).toBeGreaterThan(0.99);
    const blank = await sharp({
      create: { width: 256, height: 256, channels: 3, background: '#cccccc' },
    })
      .jpeg()
      .toBuffer();
    expect((await engine.analyze(blank)).count).toBe(0);
  }, 30000);
});
