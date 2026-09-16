import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { FaceEngineService } from './face-engine.service';
import { checkFrame, FACE_MODEL, instruction, similarity } from './face-policy';

const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const invalid = () =>
  new UnauthorizedException(
    'Face login is not set up or has expired. Log in with your password.',
  );

@Injectable()
export class FaceLoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly engine: FaceEngineService,
    private readonly users: UsersService,
  ) {}

  private key(): Buffer {
    const key =
      this.config.get<string>('FACE_LOGIN_ENCRYPTION_KEY') ||
      this.config.get<string>('JWT_SECRET');
    if (!key) throw new Error('Face login encryption key is missing');
    return createHash('sha256')
      .update(`eatwaze-face-template-v1:${key}`)
      .digest();
  }
  private encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64',
    );
  }
  private decrypt(value: string): number[][] {
    const buffer = Buffer.from(value, 'base64');
    const cipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      buffer.subarray(0, 12),
    );
    cipher.setAuthTag(buffer.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(buffer.subarray(28)),
        cipher.final(),
      ]).toString(),
    );
  }
  private checkSecret(value: string, expected: string) {
    if (
      typeof value !== 'string' ||
      value.length > 128 ||
      !timingSafeEqual(Buffer.from(hash(value)), Buffer.from(expected))
    )
      throw invalid();
  }
  private async device(id: string, key: string) {
    if (typeof id !== 'string' || id.length > 64) throw invalid();
    const device = await this.prisma.faceLoginDevice.findUnique({
      where: { id },
    });
    if (!device || device.modelVersion !== FACE_MODEL) throw invalid();
    this.checkSecret(key, device.secretHash);
    return device;
  }

  async startEnrollment(userId: string) {
    await this.users.completeFaceLogin(userId); // Reject inactive accounts before enrollment.
    const recent = await this.prisma.faceLoginAttempt.count({
      where: {
        userId,
        mode: 'enroll',
        createdAt: { gt: new Date(Date.now() - 900000) },
      },
    });
    if (recent >= 5)
      throw new HttpException(
        'Too many attempts. Try again in 15 minutes.',
        429,
      );
    return this.start(userId, 'enroll');
  }

  async startVerification(deviceId: string, deviceSecret: string) {
    const device = await this.device(deviceId, deviceSecret);
    await this.users.completeFaceLogin(device.userId, true);
    const cutoff = new Date(Date.now() - 900000);
    await this.prisma.faceLoginDevice.updateMany({
      where: { id: device.id, windowStartedAt: { lt: cutoff } },
      data: { attempts: 0, windowStartedAt: new Date() },
    });
    const claimed = await this.prisma.faceLoginDevice.updateMany({
      where: { id: device.id, attempts: { lt: 5 } },
      data: { attempts: { increment: 1 } },
    });
    if (!claimed.count)
      throw new HttpException(
        'Too many attempts. Try again in 15 minutes or use your password.',
        429,
      );
    return this.start(device.userId, 'verify', device.id);
  }

  private async start(userId: string, mode: string, deviceId?: string) {
    this.key();
    await this.prisma.faceLoginAttempt.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    const sessionSecret = secret();
    const turn = randomInt(2) === 0 ? 'left' : 'right';
    const attempt = await this.prisma.faceLoginAttempt.create({
      data: {
        userId,
        deviceId,
        mode,
        secretHash: hash(sessionSecret),
        directions: [
          'center',
          turn,
          turn === 'left' ? 'right' : 'left',
          'center',
        ],
        frameHashes: [],
        expiresAt: new Date(Date.now() + 120000),
      },
    });
    return {
      id: attempt.id,
      secret: sessionSecret,
      instruction: instruction('center'),
      step: 0,
      total: 4,
    };
  }

  async cancel(id: string, key: string) {
    const attempt = await this.prisma.faceLoginAttempt.findUnique({
      where: { id },
    });
    if (!attempt) return { cancelled: true };
    this.checkSecret(key, attempt.secretHash);
    await this.prisma.faceLoginAttempt.update({
      where: { id },
      data: { completed: true, samplesCipher: null },
    });
    return { cancelled: true };
  }

  async revoke(userId: string, deviceId: string) {
    await this.prisma.$transaction([
      this.prisma.faceLoginDevice.deleteMany({
        where: { id: deviceId, userId },
      }),
      this.prisma.faceLoginAttempt.updateMany({
        where: { deviceId, userId },
        data: { completed: true, samplesCipher: null },
      }),
    ]);
    return { revoked: true };
  }

  async frame(id: string, key: string, bytes: Buffer) {
    if (!bytes?.length || bytes.length > 5 * 1024 * 1024)
      throw new BadRequestException('Invalid camera image');
    const attempt = await this.prisma.faceLoginAttempt.findUnique({
      where: { id },
    });
    if (
      !attempt ||
      attempt.completed ||
      attempt.expiresAt.getTime() <= Date.now() ||
      attempt.frames >= 24
    )
      throw invalid();
    this.checkSecret(key, attempt.secretHash);
    const claimed = await this.prisma.faceLoginAttempt.updateMany({
      where: {
        id,
        processing: false,
        completed: false,
        step: attempt.step,
        frames: attempt.frames,
        expiresAt: { gt: new Date() },
      },
      data: { processing: true, frames: { increment: 1 } },
    });
    if (!claimed.count)
      throw new BadRequestException('Verification is already processing');
    try {
      const frameHash = hash(bytes);
      if (attempt.frameHashes.includes(frameHash))
        throw new BadRequestException('Use a fresh camera image');
      const face = await this.engine.analyze(bytes);
      const direction = attempt.directions[attempt.step];
      const retry = checkFrame(face, direction);
      if (retry)
        return {
          verified: false,
          instruction: retry,
          step: attempt.step,
          total: 4,
        };
      const samples = attempt.samplesCipher
        ? this.decrypt(attempt.samplesCipher)
        : [];
      // Every accepted pose must belong to the same person.
      if (samples.length && similarity(samples[0], face.embedding) < 0.75) {
        if (attempt.mode === 'enroll')
          return {
            verified: false,
            instruction: `Keep the same person in view. ${instruction(direction)}`,
            step: attempt.step,
            total: attempt.directions.length,
          };
        throw new UnauthorizedException(
          'Face does not match. Please try again.',
        );
      }
      if (attempt.mode === 'verify') {
        const device = await this.prisma.faceLoginDevice.findUnique({
          where: { id: attempt.deviceId },
        });
        if (
          !device ||
          device.userId !== attempt.userId ||
          device.modelVersion !== FACE_MODEL
        )
          throw invalid();
        const templates = this.decrypt(device.templateCipher);
        if (
          !templates.some(
            (template) => similarity(template, face.embedding) >= 0.8,
          )
        )
          throw new UnauthorizedException(
            'Face does not match. Please try again.',
          );
      }
      samples.push(face.embedding);
      const step = attempt.step + 1;
      const completed = step === attempt.directions.length;
      // A cancellation or expiration during inference must prevent completion.
      const accepted = await this.prisma.faceLoginAttempt.updateMany({
        where: {
          id,
          completed: false,
          processing: true,
          expiresAt: { gt: new Date() },
        },
        data: {
          step,
          completed,
          frameHashes: { push: frameHash },
          samplesCipher: completed ? null : this.encrypt(samples),
        },
      });
      if (!accepted.count) throw invalid();
      if (!completed)
        return {
          verified: false,
          instruction: instruction(attempt.directions[step]),
          step,
          total: 4,
        };
      const session = await this.users.completeFaceLogin(
        attempt.userId,
        attempt.mode === 'verify',
      );
      if (attempt.mode === 'enroll') {
        const deviceSecret = secret();
        const device = await this.prisma.faceLoginDevice.create({
          data: {
            userId: attempt.userId,
            secretHash: hash(deviceSecret),
            templateCipher: this.encrypt(samples),
            modelVersion: FACE_MODEL,
          },
        });
        return {
          verified: true,
          enrollment: {
            userId: attempt.userId,
            deviceId: device.id,
            secret: deviceSecret,
          },
        };
      }
      // Re-check revocation after the last inference; issue a token only after matching.
      const device = await this.prisma.faceLoginDevice.findUnique({
        where: { id: attempt.deviceId },
      });
      if (!device) throw invalid();
      await this.prisma.faceLoginDevice.update({
        where: { id: device.id },
        data: { attempts: 0, windowStartedAt: new Date() },
      });
      return {
        verified: true,
        session: { userId: attempt.userId, token: session.token },
      };
    } catch (error) {
      // Failed identity checks consume the whole challenge; fresh attempts are rate limited.
      if (error instanceof UnauthorizedException) {
        await this.prisma.faceLoginAttempt.updateMany({
          where: { id },
          data: { completed: true, samplesCipher: null },
        });
      }
      throw error;
    } finally {
      await this.prisma.faceLoginAttempt.updateMany({
        where: { id },
        data: { processing: false },
      });
    }
  }
}
