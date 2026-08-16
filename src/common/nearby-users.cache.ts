import { PrismaService } from '../prisma/prisma.service';
import {
  cacheGetOrSet,
  roundCoordBucket,
} from './ttl-cache.util';
import {
  effectiveNearbyRadiusKm,
  type ContentViewerRole,
} from './content-visibility.util';
import { haversineKm } from './geo.util';

export type GeoUserRow = {
  id: string;
  role: string | null;
  latitude: number | null;
  longitude: number | null;
  contentAreaKm: number | null;
  pickupAreaKm: number | null;
  deliveryAreaKm: number | null;
};

const GEO_USERS_TTL_MS = 90_000;
const NEARBY_IDS_TTL_MS = 45_000;

export async function loadUsersWithLocation(
  prisma: PrismaService,
): Promise<GeoUserRow[]> {
  return cacheGetOrSet('geo:users-with-location', GEO_USERS_TTL_MS, () =>
    prisma.user.findMany({
      where: {
        latitude: { not: null },
        longitude: { not: null },
      },
      select: {
        id: true,
        role: true,
        latitude: true,
        longitude: true,
        contentAreaKm: true,
        pickupAreaKm: true,
        deliveryAreaKm: true,
      },
    }),
  );
}

/**
 * Nearby creator ids for feeds. Cached by rounded lat/lng + role + radius.
 */
export async function resolveNearbyUserIds(
  prisma: PrismaService,
  nearbyLat: number,
  nearbyLng: number,
  radiusKm: number,
  viewerRole?: ContentViewerRole | string | null,
): Promise<string[]> {
  const key = `geo:nearby:${roundCoordBucket(nearbyLat)}:${roundCoordBucket(
    nearbyLng,
  )}:${Math.round(radiusKm)}:${String(viewerRole || 'user').toLowerCase()}`;

  return cacheGetOrSet(key, NEARBY_IDS_TTL_MS, async () => {
    const usersWithLocation = await loadUsersWithLocation(prisma);
    return usersWithLocation
      .filter((u) => {
        if (u.latitude == null || u.longitude == null) return false;
        const distanceKm = haversineKm(
          nearbyLat,
          nearbyLng,
          u.latitude,
          u.longitude,
        );
        const effectiveRadiusKm = effectiveNearbyRadiusKm(
          viewerRole,
          u,
          radiusKm,
        );
        return distanceKm <= effectiveRadiusKm;
      })
      .map((u) => u.id);
  });
}
