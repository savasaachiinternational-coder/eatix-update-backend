import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentsModule } from '../payments/payments.module';
import { NoLogoCreditsController } from './no-logo-credits.controller';
import { NoLogoCreditsService } from './no-logo-credits.service';

@Module({
  imports: [PrismaModule, forwardRef(() => PaymentsModule)],
  controllers: [NoLogoCreditsController],
  providers: [NoLogoCreditsService],
  exports: [NoLogoCreditsService],
})
export class NoLogoCreditsModule {}
