jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
jest.mock('@nestjs/axios', () => ({ HttpService: class {}, HttpModule: class {} }));
import { HomeService } from './home.service';

describe('HomeService feed video subscriptions', () => {
  const videos = [
    { id: 'v1', userId: 'o1', user: { id: 'o1', role: 'owner' } },
    { id: 'v2', userId: 'o2', user: { id: 'o2', role: 'owner' } },
  ];

  const build = (subscribedOwners: string[] | Error) => {
    const findMany =
      subscribedOwners instanceof Error
        ? jest.fn().mockRejectedValue(subscribedOwners)
        : jest
            .fn()
            .mockResolvedValue(subscribedOwners.map((id) => ({ channelUserId: id })));
    const service = new HomeService(
      { findAllPublic: async () => ({ featured: [] }) } as any,
      { findAllPublic: async () => ({ sponsored: [] }) } as any,
      { getVideos: async () => ({ videos, pagination: null }) } as any,
      { getShorts: async () => ({ shorts: [], pagination: null }) } as any,
      { channelSubscription: { findMany } } as any,
    );
    return { service, findMany };
  };

  it('marks each video owner subscribed/not for the viewer in one query', async () => {
    const { service, findMany } = build(['o2']);
    const res = await service.getFeed({ viewerUserId: 'viewer-a', nearbyLat: 53.1, nearbyLng: -3.1 } as any);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({
      subscriberId: 'viewer-a',
      channelUserId: { in: ['o1', 'o2'] },
    });
    expect(res.videos.map((v: any) => v.user.isSubscribed)).toEqual([false, true]);
  });

  it('anonymous viewer: no query, videos untouched', async () => {
    const { service, findMany } = build([]);
    const res = await service.getFeed({ nearbyLat: 53.2, nearbyLng: -3.2 } as any);
    expect(findMany).not.toHaveBeenCalled();
    expect(res.videos[0].user.isSubscribed).toBeUndefined();
  });

  it('subscription lookup failure falls back to plain videos', async () => {
    const { service } = build(new Error('db down'));
    const res = await service.getFeed({ viewerUserId: 'viewer-b', nearbyLat: 53.3, nearbyLng: -3.3 } as any);
    expect(res.videos).toHaveLength(2);
    expect(res.videos[0].user.isSubscribed).toBeUndefined();
  });
});
