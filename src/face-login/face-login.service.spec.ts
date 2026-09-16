import { createHash } from 'crypto';
import { FaceLoginService } from './face-login.service';
import { FACE_MODEL } from './face-policy';
jest.mock('../users/users.service', () => ({ UsersService: class {} }));

describe('camera face login authorization', () => {
  let service: FaceLoginService;
  let prisma: any;
  let engine: any;
  let users: any;
  let attempt: any;
  let device: any;
  const key = 'challenge-secret';
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const observation = (yaw) => ({
    count: 1,
    embedding: Array(128).fill(1),
    score: 0.99,
    real: 0.99,
    live: 0.99,
    yaw,
    pitch: 0,
    size: 180,
  });
  const frame = (index = 0) =>
    service.frame('attempt', key, Buffer.from(`image-${index}`));
  beforeEach(() => {
    attempt = {
      id: 'attempt',
      userId: 'user',
      secretHash: hash(key),
      mode: 'enroll',
      directions: ['center', 'left', 'right', 'center'],
      step: 0,
      frames: 0,
      frameHashes: [],
      samplesCipher: null,
      processing: false,
      completed: false,
      expiresAt: new Date(Date.now() + 120000),
    };
    device = null;
    prisma = {
      faceLoginAttempt: {
        findUnique: jest.fn(async () => ({ ...attempt })),
        updateMany: jest.fn(async ({ where, data }) => {
          if (
            where.completed !== undefined &&
            where.completed !== attempt.completed
          )
            return { count: 0 };
          if (
            where.processing !== undefined &&
            where.processing !== attempt.processing
          )
            return { count: 0 };
          if (where.frames !== undefined && where.frames !== attempt.frames)
            return { count: 0 };
          if (where.expiresAt && attempt.expiresAt <= where.expiresAt.gt)
            return { count: 0 };
          for (const [name, value] of Object.entries(data) as any) {
            if (value?.increment) attempt[name] += value.increment;
            else if (value?.push)
              attempt[name] = [...attempt[name], value.push];
            else attempt[name] = value;
          }
          return { count: 1 };
        }),
        count: jest.fn(async () => 0),
        deleteMany: jest.fn(async () => ({})),
        create: jest.fn(async ({ data }) => ({ ...data, id: 'new-attempt' })),
      },
      faceLoginDevice: {
        create: jest.fn(async ({ data }) => {
          device = { ...data, id: 'device' };
          return device;
        }),
        findUnique: jest.fn(async () => device),
        update: jest.fn(async () => device),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    engine = { analyze: jest.fn(async () => observation(0)) };
    users = {
      completeFaceLogin: jest.fn(async () => ({ token: 'fresh-login-token' })),
    };
    service = new FaceLoginService(
      prisma,
      { get: () => 'test-encryption-key' } as any,
      engine,
      users,
    );
  });

  async function enroll() {
    for (const [index, yaw] of [0, 0.3, -0.3, 0].entries()) {
      engine.analyze.mockResolvedValueOnce(observation(yaw));
      const result = await frame(index);
      if (index < 3) {
        expect(result.verified).toBe(false);
        expect(prisma.faceLoginDevice.create).not.toHaveBeenCalled();
      } else return result;
    }
  }

  it('enrolls only after every pose, encrypts templates and hashes device credentials', async () => {
    const result: any = await enroll();
    expect(result.verified).toBe(true);
    expect(result.session).toBeUndefined();
    expect(device.modelVersion).toBe(FACE_MODEL);
    expect(device.secretHash).toBe(hash(result.enrollment.secret));
    expect(device.templateCipher).not.toContain('[1,1');
    expect(attempt.samplesCipher).toBeNull();
    expect(attempt.completed).toBe(true);
  });

  it('issues a fresh login session only after live frames match the registered face', async () => {
    await enroll();
    attempt = {
      ...attempt,
      mode: 'verify',
      deviceId: 'device',
      completed: false,
      step: 0,
      frames: 0,
      frameHashes: [],
    };
    users.completeFaceLogin.mockClear();
    for (const [index, yaw] of [0, 0.3, -0.3, 0].entries()) {
      engine.analyze.mockResolvedValueOnce(observation(yaw));
      const result: any = await frame(index + 10);
      if (index < 3) {
        expect(result.session).toBeUndefined();
        expect(users.completeFaceLogin).not.toHaveBeenCalled();
      } else
        expect(result.session).toEqual({
          userId: 'user',
          token: 'fresh-login-token',
        });
    }
  });

  it('blocks another face and consumes the attempt without issuing credentials', async () => {
    await enroll();
    attempt = {
      ...attempt,
      mode: 'verify',
      deviceId: 'device',
      completed: false,
      step: 0,
      frames: 0,
      frameHashes: [],
    };
    users.completeFaceLogin.mockClear();
    engine.analyze.mockResolvedValueOnce({
      ...observation(0),
      embedding: Array(128).fill(20),
    });
    await expect(frame(10)).rejects.toThrow('Face does not match');
    expect(attempt.completed).toBe(true);
    expect(users.completeFaceLogin).not.toHaveBeenCalled();
  });

  it('does not advance when liveness checks fail', async () => {
    engine.analyze.mockResolvedValueOnce({ ...observation(0), live: 0.1 });
    expect((await frame()).verified).toBe(false);
    expect(attempt.step).toBe(0);
    expect(prisma.faceLoginDevice.create).not.toHaveBeenCalled();
  });

  it('rejects cancellation during inference even if the model finds a match', async () => {
    engine.analyze.mockImplementationOnce(async () => {
      attempt.completed = true;
      return observation(0);
    });
    await expect(frame()).rejects.toThrow('not set up or has expired');
    expect(prisma.faceLoginDevice.create).not.toHaveBeenCalled();
  });

  it.each(['expired', 'completed', 'exhausted', 'busy', 'bad-secret'])(
    'rejects %s attempts before inference',
    async (state) => {
      if (state === 'expired') attempt.expiresAt = new Date(0);
      if (state === 'completed') attempt.completed = true;
      if (state === 'exhausted') attempt.frames = 24;
      if (state === 'busy') attempt.processing = true;
      if (state === 'bad-secret') attempt.secretHash = hash('different');
      await expect(frame()).rejects.toThrow();
      expect(engine.analyze).not.toHaveBeenCalled();
    },
  );

  it('does not accept an earlier image again', async () => {
    await frame();
    await expect(frame()).rejects.toThrow('fresh camera image');
  });

  it('limits repeated verification challenges per enrolled device', async () => {
    const result: any = await enroll();
    prisma.faceLoginDevice.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.startVerification(device.id, result.enrollment.secret),
    ).rejects.toThrow('Too many attempts');
    expect(prisma.faceLoginAttempt.create).not.toHaveBeenCalled();
  });
});
