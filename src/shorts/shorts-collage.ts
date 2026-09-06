/** Must match Ethics-app `src/constants/collageLayouts.js`. */

export type CollageSlot = { x: number; y: number; w: number; h: number };

export type CollageLayout = {
  id: string;
  slots: CollageSlot[];
  maxVideos: number;
};

export const COLLAGE_LAYOUTS: CollageLayout[] = [
  {
    id: 'split-h-2',
    slots: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ],
    maxVideos: 2,
  },
  {
    id: 'split-v-2',
    slots: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 },
    ],
    maxVideos: 2,
  },
  {
    id: 'triple-top',
    slots: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
    maxVideos: 2,
  },
  {
    id: 'grid-2x2',
    slots: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
    maxVideos: 2,
  },
];

export function getCollageLayout(id?: string | null): CollageLayout | null {
  return COLLAGE_LAYOUTS.find((l) => l.id === String(id || '')) || null;
}

function evenSize(n: number): number {
  const x = Math.max(2, Math.round(Number(n) || 0));
  return x % 2 === 0 ? x : x + 1;
}

function evenCoord(n: number): number {
  const x = Math.max(0, Math.round(Number(n) || 0));
  return x % 2 === 0 ? x : x + 1;
}

export function layoutSlotPixels(
  layout: CollageLayout,
  canvasW: number,
  canvasH: number,
  gutterPx = 8,
): Array<{ x: number; y: number; w: number; h: number }> {
  const W = evenSize(canvasW);
  const H = evenSize(canvasH);
  const g = Math.max(0, Math.round(Number(gutterPx) || 0));
  return layout.slots.map((slot) => {
    const x = evenCoord(slot.x * W + (slot.x > 0 ? g / 2 : 0));
    const y = evenCoord(slot.y * H + (slot.y > 0 ? g / 2 : 0));
    const right = evenCoord(
      (slot.x + slot.w) * W - (slot.x + slot.w < 1 ? g / 2 : 0),
    );
    const bottom = evenCoord(
      (slot.y + slot.h) * H - (slot.y + slot.h < 1 ? g / 2 : 0),
    );
    return {
      x,
      y,
      w: Math.max(2, evenSize(right - x)),
      h: Math.max(2, evenSize(bottom - y)),
    };
  });
}

export function xstackLayout(
  slots: Array<{ x: number; y: number }>,
): string {
  return slots.map((s) => `${s.x}_${s.y}`).join('|');
}
