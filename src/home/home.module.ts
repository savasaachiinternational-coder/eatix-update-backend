import { Module } from '@nestjs/common';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';
import { FeaturedModule } from '../featured/featured.module';
import { SponsoredModule } from '../sponsored/sponsored.module';
import { VideoModule } from '../video/video.module';
import { ShortsModule } from '../shorts/shorts.module';

@Module({
  imports: [FeaturedModule, SponsoredModule, VideoModule, ShortsModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
