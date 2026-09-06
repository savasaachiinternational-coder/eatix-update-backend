import * as path from 'path';

export const STICKER_IDS = [
  'yum',
  'spicy',
  'fresh',
  'chef',
  'star',
  'heart',
  'new',
  'sale',
] as const;

export type StickerId = (typeof STICKER_IDS)[number];

export type StickerLayer = {
  catalogId: string;
  xPct: number;
  yPct: number;
  scale: number;
  rotateDeg: number;
  startSec: number;
  endSec: number;
};

export function isStickerId(id: string): id is StickerId {
  return (STICKER_IDS as readonly string[]).includes(id);
}

export function stickerPngPath(id: string): string | null {
  if (!isStickerId(id)) return null;
  return path.join(__dirname, '..', '..', 'assets', 'stickers', `${id}.png`);
}

export function normalizeStickerLayers(raw: unknown): StickerLayer[] {
  if (!Array.isArray(raw)) return [];
  const out: StickerLayer[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const catalogId = String(rec.catalogId || rec.id || '');
    if (!isStickerId(catalogId)) continue;
    const start = Math.max(0, Number(rec.startSec ?? 0));
    const end = Math.max(start + 0.05, Number(rec.endSec ?? 8));
    out.push({
      catalogId,
      xPct: Math.max(0, Math.min(1, Number(rec.xPct ?? 0.82))),
      yPct: Math.max(0, Math.min(1, Number(rec.yPct ?? 0.16))),
      scale: Math.max(0.3, Math.min(3, Number(rec.scale ?? 1))),
      rotateDeg: Number(rec.rotateDeg || 0),
      startSec: start,
      endSec: end,
    });
    if (out.length >= 8) break;
  }
  return out;
}
