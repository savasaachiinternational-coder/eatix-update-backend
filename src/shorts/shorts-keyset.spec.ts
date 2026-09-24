jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
jest.mock('@nestjs/axios', () => ({ HttpService: class {}, HttpModule: class {} }));
import { ShortsService } from './shorts.service';
import { decodeFeedCursor, encodeFeedCursor } from '../common/feed-cursor.util';

describe('feed cursor util', () => {
  it('round-trips date and number cursors', () => {
    const d = { v: '2026-09-20T10:00:00.000Z', id: 'abc' };
    expect(decodeFeedCursor(encodeFeedCursor(d))).toEqual(d);
    const n = { v: 42, id: 'xyz' };
    expect(decodeFeedCursor(encodeFeedCursor(n))).toEqual(n);
  });

  it('treats start/garbage as first page', () => {
    expect(decodeFeedCursor('start')).toBeNull();
    expect(decodeFeedCursor('not-base64-json')).toBeNull();
    expect(decodeFeedCursor(undefined)).toBeNull();
  });
});

describe('ShortsService.getShorts keyset mode', () => {
  const makeRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `s${10 - i}`,
      userId: 'u1',
      createdAt: new Date(Date.UTC(2026, 8, 20, 10, 0, 10 - i)),
      viewCount: 100 - i,
      videoUrl: 'https://cdn.example.com/a.mp4',
      user: { id: 'u1' },
    }));

  const build = (rows: any[]) => {
    const findMany = jest.fn().mockResolvedValue(rows);
    const count = jest.fn();
    const service = Object.create(ShortsService.prototype) as any;
    service.prisma = {
      short: { findMany, count },
      shortLike: { findMany: jest.fn().mockResolvedValue([]) },
      channelSubscription: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service.publicShortPublishedWhere = () => ({});
    return { service, findMany, count };
  };

  it('first page: take limit+1, no count, returns nextCursor', async () => {
    const { service, findMany, count } = build(makeRows(4));
    const res = await service.getShorts({ cursor: 'start', limit: 3, fields: 'card' });
    expect(count).not.toHaveBeenCalled();
    const args = findMany.mock.calls[0][0];
    expect(args.take).toBe(4);
    expect(args.skip).toBeUndefined();
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(res.shorts).toHaveLength(3);
    expect(res.pagination.hasMore).toBe(true);
    expect(decodeFeedCursor(res.pagination.nextCursor)).toEqual({
      v: new Date(Date.UTC(2026, 8, 20, 10, 0, 8)).toISOString(),
      id: 's8',
    });
  });

  it('next page: filters strictly after the cursor with id tie-break', async () => {
    const { service, findMany } = build(makeRows(2));
    const cursor = encodeFeedCursor({ v: '2026-09-20T10:00:08.000Z', id: 's8' });
    const res = await service.getShorts({ cursor, limit: 3, fields: 'card' });
    const where = findMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({
      OR: [
        { createdAt: { lt: new Date('2026-09-20T10:00:08.000Z') } },
        { createdAt: new Date('2026-09-20T10:00:08.000Z'), id: { lt: 's8' } },
      ],
    });
    expect(res.pagination).toEqual({ limit: 3, hasMore: false, nextCursor: null });
  });

  it('trending sorts by viewCount then id', async () => {
    const { service, findMany } = build(makeRows(1));
    const cursor = encodeFeedCursor({ v: 50, id: 's5' });
    await service.getShorts({ cursor, limit: 3, sort: 'trending', fields: 'card' });
    const args = findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ viewCount: 'desc' }, { id: 'desc' }]);
    expect(args.where.AND).toContainEqual({
      OR: [{ viewCount: { lt: 50 } }, { viewCount: 50, id: { lt: 's5' } }],
    });
  });

  it('without cursor keeps legacy page/count behaviour', async () => {
    const { service, findMany, count } = build(makeRows(2));
    count.mockResolvedValue(2);
    const res = await service.getShorts({ page: 1, limit: 3, search: 'x' });
    expect(count).toHaveBeenCalled();
    expect(findMany.mock.calls[0][0].skip).toBe(0);
    expect(res.pagination).toMatchObject({ total: 2, page: 1, limit: 3 });
  });
});
