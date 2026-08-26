import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';

export const NO_LOGO_PACKAGES = [
  {
    key: 'pack10',
    displayName: 'Starter',
    itemCount: 10,
    priceGbp: 2,
    description: '10 shorts, videos or images without Eatwaze logo',
  },
  {
    key: 'pack20',
    displayName: 'Plus',
    itemCount: 20,
    priceGbp: 3.5,
    description: '20 shorts, videos or images without Eatwaze logo',
  },
  {
    key: 'pack30',
    displayName: 'Pro',
    itemCount: 30,
    priceGbp: 5,
    description: '30 shorts, videos or images without Eatwaze logo',
  },
] as const;

export type NoLogoPackageKey = (typeof NO_LOGO_PACKAGES)[number]['key'];

@Injectable()
export class NoLogoCreditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  listPackages() {
    return NO_LOGO_PACKAGES.map((p) => ({ ...p }));
  }

  getPackage(key: string) {
    return NO_LOGO_PACKAGES.find((p) => p.key === key) || null;
  }

  async getBalance(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { noLogoCredits: true },
    });
    return {
      credits: Number(user?.noLogoCredits || 0),
      packages: this.listPackages(),
    };
  }

  async createPurchaseIntent(userId: string, packageKey: string) {
    if (!this.payments.isEnabled()) {
      throw new ServiceUnavailableException('Stripe is not configured');
    }
    const pkg = this.getPackage(packageKey);
    if (!pkg) {
      throw new BadRequestException('Invalid package');
    }
    const intent = await this.payments.createPaymentIntent({
      userId,
      ownerId: userId,
      totalAmount: pkg.priceGbp,
      currency: 'gbp',
      description: `Eatwaze no-logo pack: ${pkg.itemCount} uploads`,
      metadata: {
        type: 'no_logo_credits',
        packageKey: pkg.key,
        itemCount: String(pkg.itemCount),
      },
    });
    return {
      ...intent,
      package: pkg,
      requiresPayment: true,
      totalAmount: pkg.priceGbp,
      currency: 'gbp',
    };
  }

  async confirmPurchase(userId: string, paymentIntentId: string) {
    const pi = String(paymentIntentId || '').trim();
    if (!pi) throw new BadRequestException('paymentIntentId is required');

    const existing = await this.prisma.noLogoCreditPurchase.findUnique({
      where: { stripePaymentIntentId: pi },
    });
    if (existing) {
      const bal = await this.getBalance(userId);
      return {
        alreadyApplied: true,
        purchase: existing,
        credits: bal.credits,
      };
    }

    const verified = await this.payments.verifyPaymentIntentSucceeded({
      paymentIntentId: pi,
      userId,
      expectedType: 'no_logo_credits',
    });

    const packageKey = String(verified.metadata?.packageKey || '');
    const pkg = this.getPackage(packageKey);
    if (!pkg) {
      throw new BadRequestException('Payment metadata package is invalid');
    }

    const expectedPence = this.payments.toStripeAmount(pkg.priceGbp);
    if (verified.amountReceived < expectedPence) {
      throw new BadRequestException('Payment amount does not match package');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const purchase = await tx.noLogoCreditPurchase.create({
        data: {
          userId,
          packageKey: pkg.key,
          itemCount: pkg.itemCount,
          amountGbp: pkg.priceGbp,
          stripePaymentIntentId: pi,
          status: 'paid',
        },
      });
      const user = await tx.user.update({
        where: { id: userId },
        data: { noLogoCredits: { increment: pkg.itemCount } },
        select: { noLogoCredits: true },
      });
      return { purchase, credits: user.noLogoCredits };
    });

    return { alreadyApplied: false, ...result };
  }

  async assertCanSkipWatermark(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { noLogoCredits: true },
    });
    const credits = Number(user?.noLogoCredits || 0);
    if (credits < 1) {
      throw new BadRequestException(
        'No no-logo credits left. Buy a pack to upload without the Eatwaze logo, or publish with logo for free.',
      );
    }
    return credits;
  }

  async consumeOneCredit(userId: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { noLogoCredits: true },
      });
      const credits = Number(user?.noLogoCredits || 0);
      if (credits < 1) {
        throw new BadRequestException('No no-logo credits left');
      }
      return tx.user.update({
        where: { id: userId },
        data: { noLogoCredits: { decrement: 1 } },
        select: { noLogoCredits: true },
      });
    });
    return Number(updated.noLogoCredits || 0);
  }
}
