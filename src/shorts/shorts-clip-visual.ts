import { CanvasTarget } from './shorts-ffmpeg-presets';

export type ClipVisual = { transform?: Record<string, unknown>; adjustments?: Record<string, unknown> };
const bound = (v: unknown, min: number, max: number, fallback: number) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : fallback;

/** The same geometry as app/editor/clipVisual.js: rotate, flip, fit, focal zoom. */
export function buildClipVisualFilter(meta: ClipVisual, canvas: Partial<CanvasTarget> = {}): string {
  const t = meta.transform || {}, a = meta.adjustments || {};
  const w = Math.max(2, Math.round((canvas.w || 1080) / 2) * 2);
  const h = Math.max(2, Math.round((canvas.h || 1920) / 2) * 2);
  const zoom = bound(t.zoom, 1, 3, 1), x = bound(t.x, 0, 1, 0.5), y = bound(t.y, 0, 1, 0.5);
  const fit = t.fit === 'fit' || t.fit == null && canvas.fit === 'fit';
  const bg = /^#[0-9a-f]{6}$/i.test(canvas.backgroundHex || '') ? canvas.backgroundHex!.replace('#', '0x') : '0x000000';
  const filters: string[] = [];
  if (t.rotation === 90) filters.push('transpose=clock');
  if (t.rotation === 180) filters.push('hflip', 'vflip');
  if (t.rotation === 270) filters.push('transpose=cclock');
  if (t.flipX === true) filters.push('hflip');
  if (t.flipY === true) filters.push('vflip');
  const factor = `${fit ? 'min' : 'max'}(${w}/iw,${h}/ih)*${zoom}`;
  filters.push(`scale=w='max(2,trunc(iw*(${factor})/2)*2)':h='max(2,trunc(ih*(${factor})/2)*2)'`);
  filters.push(`crop=w='min(iw,${w})':h='min(ih,${h})':x='(iw-ow)*${x}':y='(ih-oh)*${y}'`);
  filters.push(`pad=${w}:${h}:(ow-iw)*${x}:(oh-ih)*${y}:${bg}`, 'setsar=1');
  const brightness = bound(a.brightness, -1, 1, 0) * 0.35;
  const contrast = 1 + bound(a.contrast, -1, 1, 0) * 0.8;
  const saturation = 1 + bound(a.saturation, -1, 1, 0);
  if (brightness || contrast !== 1 || saturation !== 1) filters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);
  const warmth = bound(a.temperature, -1, 1, 0) * 0.25;
  if (warmth) filters.push(`colorbalance=rm=${warmth}:bm=${-warmth}:rh=${warmth / 2}:bh=${-warmth / 2}`);
  const sharpness = bound(a.sharpness, 0, 1, 0);
  if (sharpness) filters.push(`unsharp=5:5:${sharpness * 1.5}:5:5:0`);
  const vignette = bound(a.vignette, 0, 1, 0);
  if (vignette) filters.push(`vignette=angle=${vignette * Math.PI / 3}`);
  return filters.join(',');
}
