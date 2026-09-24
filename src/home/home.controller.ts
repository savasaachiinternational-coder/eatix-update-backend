import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HomeService } from './home.service';
import { HomeFeedQueryDto } from './dto/home-feed-query.dto';

@ApiTags('home')
@Controller('home')
export class HomeController {
  constructor(private readonly homeService: HomeService) {}

  @Get('feed')
  @ApiOperation({
    summary:
      'Home first-paint bootstrap (featured + sponsored + card videos/shorts)',
  })
  @ApiResponse({ status: 200, description: 'Lightweight home feed bundle' })
  getFeed(@Query() query: HomeFeedQueryDto) {
    return this.homeService.getFeed(query);
  }
}
