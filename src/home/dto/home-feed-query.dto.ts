import {
  IsInt,
  IsOptional,
  IsString,
  Min,
  Max,
  IsNumber,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/** Single bootstrap payload for the home screen first paint. */
export class HomeFeedQueryDto {
  @ApiPropertyOptional({ description: 'Nearby latitude' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  nearbyLat?: number;

  @ApiPropertyOptional({ description: 'Nearby longitude' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  nearbyLng?: number;

  @ApiPropertyOptional({ description: 'Radius km', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(200)
  radiusKm?: number;

  @ApiPropertyOptional({ description: 'Viewer role' })
  @IsOptional()
  @IsString()
  viewerRole?: string;

  @ApiPropertyOptional({ description: 'Viewer user id (likes/subs)' })
  @IsOptional()
  @IsString()
  viewerUserId?: string;

  @ApiPropertyOptional({ description: 'Shorts page size', default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  shortsLimit?: number;

  @ApiPropertyOptional({ description: 'Videos page size', default: 8 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  videosLimit?: number;
}
