import { Injectable } from '@nestjs/common';
import { FeaturedService } from '../featured/featured.service';
import { SponsoredService } from '../sponsored/sponsored.service';
import { VideoService } from '../video/video.service';
import { ShortsService } from '../shorts/shorts.service';
import { UK_DEFAULT_RADIUS_KM } from '../common/geo.util';
import { cacheGetOrSet, roundCoordBucket } from '../common/ttl-cache.util';
import { HomeFeedQueryDto } from './dto/home-feed-query.dto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Aggregates only what HomeOne first paint needs in one round-trip.
 * Uses card-shaped media lists (lighter than full rows).
 */
@Injectable()
export class HomeService {
  constructor(
    private readonly featuredService: FeaturedService,
    private readonly sponsoredService: SponsoredService,
    private readonly videoService: VideoService,
    private readonly shortsService: ShortsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Adds the viewer's user.isSubscribed to each video card (shorts already carry it)
   * so the app does not call channel-profile once per owner.
   */
  private async withViewerSubscriptions(videos: any[], viewerUserId?: string) {
    if (!viewerUserId || !Array.isArray(videos) || videos.length === 0) {
      return videos;
    }
    const ownerIds = Array.from(
      new Set(videos.map((v) => v?.userId).filter(Boolean)),
    );
    if (ownerIds.length === 0) return videos;
    const rows = await this.prisma.channelSubscription.findMany({
      where: { subscriberId: viewerUserId, channelUserId: { in: ownerIds } },
      select: { channelUserId: true },
    });
    const subscribed = new Set(rows.map((r) => r.channelUserId));
    return videos.map((v) =>
      v?.user
        ? { ...v, user: { ...v.user, isSubscribed: subscribed.has(v.userId) } }
        : v,
    );
  }

  async getFeed(query: HomeFeedQueryDto) {
    const nearbyLat = query.nearbyLat;
    const nearbyLng = query.nearbyLng;
    const radiusKm = query.radiusKm ?? UK_DEFAULT_RADIUS_KM;
    const viewerRole = query.viewerRole;
    const viewerUserId = query.viewerUserId;
    const shortsLimit = query.shortsLimit ?? 12;
    const videosLimit = query.videosLimit ?? 8;

    const cacheKey = `home:feed:${roundCoordBucket(Number(nearbyLat))}:${roundCoordBucket(Number(nearbyLng))}:${radiusKm}:${viewerRole || 'any'}:${viewerUserId || 'anon'}:s${shortsLimit}:v${videosLimit}`;

    return cacheGetOrSet(cacheKey, 25_000, async () => {
      const [featuredRes, sponsoredRes, videosRes, shortsRes] =
        await Promise.all([
          this.featuredService.findAllPublic().catch(() => ({ featured: [] })),
          this.sponsoredService
            .findAllPublic()
            .catch(() => ({ sponsored: [] })),
          this.videoService.getVideos({
            page: 1,
            limit: videosLimit,
            sort: 'latest',
            fields: 'card',
            nearbyLat,
            nearbyLng,
            radiusKm,
            viewerRole,
            excludeSponsored: true,
            excludeFeatured: true,
          }),
          this.shortsService.getShorts({
            page: 1,
            limit: shortsLimit,
            sort: 'latest',
            fields: 'card',
            nearbyLat,
            nearbyLng,
            radiusKm,
            viewerRole,
            viewerUserId,
          }),
        ]);

      return {
        featured: Array.isArray(featuredRes?.featured)
          ? featuredRes.featured
          : featuredRes?.featured
            ? [featuredRes.featured]
            : [],
        sponsored: Array.isArray(sponsoredRes?.sponsored)
          ? sponsoredRes.sponsored
          : sponsoredRes?.sponsored
            ? [sponsoredRes.sponsored]
            : [],
        videos: await this.withViewerSubscriptions(
          videosRes?.videos ?? [],
          viewerUserId,
        ).catch(() => videosRes?.videos ?? []),
        shorts: shortsRes?.shorts ?? [],
        pagination: {
          videos: videosRes?.pagination ?? null,
          shorts: shortsRes?.pagination ?? null,
        },
      };
    });
  }
}
