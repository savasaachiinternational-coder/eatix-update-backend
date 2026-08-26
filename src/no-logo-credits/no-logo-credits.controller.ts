import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../users/dto/currentUser';
import { NoLogoCreditsService } from './no-logo-credits.service';

class BuyNoLogoPackDto {
  @IsString()
  @IsNotEmpty()
  packageKey: string;
}

class ConfirmNoLogoPackDto {
  @IsString()
  @IsNotEmpty()
  paymentIntentId: string;
}

@ApiTags('no-logo-credits')
@Controller('no-logo-credits')
export class NoLogoCreditsController {
  constructor(private readonly service: NoLogoCreditsService) {}

  @Get('packages')
  @ApiOperation({ summary: 'List no-logo credit packages' })
  listPackages() {
    return this.service.listPackages();
  }

  @Get('balance')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Current no-logo credit balance' })
  getBalance(@CurrentUser() user: { id: string }) {
    return this.service.getBalance(user.id);
  }

  @Post('create-intent')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Start Stripe payment for a no-logo pack' })
  createIntent(
    @CurrentUser() user: { id: string },
    @Body() dto: BuyNoLogoPackDto,
  ) {
    return this.service.createPurchaseIntent(user.id, dto.packageKey);
  }

  @Post('confirm')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Confirm Stripe payment and grant credits' })
  confirm(
    @CurrentUser() user: { id: string },
    @Body() dto: ConfirmNoLogoPackDto,
  ) {
    return this.service.confirmPurchase(user.id, dto.paymentIntentId);
  }
}
