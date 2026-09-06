import filterPresetSpec from './filter-preset-spec.json';

/**
 * FFmpeg video filters aligned with app `filterEffects.js`.
 * Preview uses a semi-transparent color overlay; we bake the same blend into pixels
 * so the stored MP4 matches what users see (plus beauty/speed/sound elsewhere).
 */

/**
 * Built from filter-preset-spec.json, a file checked into BOTH this repo
 * and Ethics-app (src/constants/filter-preset-spec.json) so they can never
 * drift apart silently — a checksum guard (`npm run verify:filter-spec`)
 * fails the build if this JSON changes without a matching, reviewed edit
 * on both sides. See SYNC.md at the repo root. Do not hand-edit this
 * Record; edit the JSON and regenerate the checksum instead.
 */
const FILTER_OVERLAY: Record<string, { hex: string; opacity: number }> =
  Object.fromEntries(
    (filterPresetSpec.presets as Array<{ id: string; hex: string; opacity: number }>).map(
      (preset) => [preset.id, { hex: preset.hex, opacity: preset.opacity }],
    ),
  );

/** When `filterId` is unknown (e.g. CMS-only), still apply a mild grade so output is re-encoded. */
const FILTER_FALLBACK_VF =
  'eq=saturation=1.06:contrast=1.04:brightness=0.005';

function parseHexRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace('#', '').trim();
  if (!/^[0-9A-Fa-f]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * Matches RN preview: out = src * (1 - a) + overlayRGB * a (per channel, rgb24).
 */
function buildOverlayColorGrade(hex: string, opacity: number): string {
  const a = Math.min(1, Math.max(0, opacity));
  if (a <= 0) return '';
  const rgb = parseHexRgb(hex);
  if (!rgb) return '';
  const om = 1 - a;
  const ar = rgb.r * a;
  const ag = rgb.g * a;
  const ab = rgb.b * a;
  return [
    'format=rgb24',
    `geq=r='r(X,Y)*${om}+${ar}':g='g(X,Y)*${om}+${ag}':b='b(X,Y)*${om}+${ab}'`,
    'format=yuv420p',
  ].join(',');
}

export type CanvasFit = 'fill' | 'fit';
export type CanvasQuality = '720p' | '1080p';
export type CanvasRatio = '9:16' | '1:1' | '4:5' | '16:9';

export type CanvasTarget = {
  w: number;
  h: number;
  fit: CanvasFit;
  backgroundHex: string;
};

/** Must match Ethics-app `src/constants/canvasSpec.js` CANVAS_DIMS. */
const CANVAS_DIMS: Record<
  CanvasQuality,
  Record<CanvasRatio, { w: number; h: number }>
> = {
  '720p': {
    '9:16': { w: 720, h: 1280 },
    '1:1': { w: 720, h: 720 },
    '4:5': { w: 720, h: 900 },
    '16:9': { w: 1280, h: 720 },
  },
  '1080p': {
    '9:16': { w: 1080, h: 1920 },
    '1:1': { w: 1080, h: 1080 },
    '4:5': { w: 1080, h: 1350 },
    '16:9': { w: 1920, h: 1080 },
  },
};

function evenPx(n: number): number {
  const x = Math.max(2, Math.round(Number(n) || 0));
  return x % 2 === 0 ? x : x + 1;
}

export function parseCanvasRatio(raw?: string | null): CanvasRatio {
  const key = String(raw || '').trim();
  if (key === '1:1' || key === '4:5' || key === '16:9' || key === '9:16') {
    return key;
  }
  return '9:16';
}

export function parseCanvasQuality(raw?: string | null): CanvasQuality {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s === '720p' || s === '720x1280') return '720p';
  if (s === '1080p' || s === '1080x1920') return '1080p';
  return '1080p';
}

export function parseCanvasFit(raw?: string | null): CanvasFit {
  return String(raw || '')
    .trim()
    .toLowerCase() === 'fit'
    ? 'fit'
    : 'fill';
}

export function normalizeBackgroundHex(
  raw?: string | null,
  fallback = '#000000',
): string {
  const s = String(raw || '').trim();
  const m = s.match(/^#?([0-9A-Fa-f]{6})$/);
  if (!m) return fallback;
  return `#${m[1].toUpperCase()}`;
}

export function ffmpegPadColor(hex: string): string {
  const n = normalizeBackgroundHex(hex).slice(1);
  return `0x${n}`;
}

export function resolveCanvasDims(
  aspectRatio?: string | null,
  quality?: string | null,
): { w: number; h: number } {
  const ratio = parseCanvasRatio(aspectRatio);
  const q = parseCanvasQuality(quality);
  const dims = CANVAS_DIMS[q][ratio];
  return { w: evenPx(dims.w), h: evenPx(dims.h) };
}

/**
 * 1080p table only — kept for callers that have a ratio and no quality.
 */
export function resolveExportDimsForAspectRatio(
  aspectRatio?: string | null,
): { w: number; h: number } | null {
  const key = String(aspectRatio || '').trim();
  if (!key) return null;
  if (key !== '9:16' && key !== '1:1' && key !== '4:5' && key !== '16:9') {
    return null;
  }
  return resolveCanvasDims(key, '1080p');
}

function inferQualityFromDims(w: number, h: number): CanvasQuality {
  const long = Math.max(w, h);
  if (long > 0 && long <= 800) return '720p';
  return '1080p';
}

/**
 * Preview and export share this. Default fit is fill (cover/crop), matching
 * the RN `resizeMode="cover"` preview. Old clients sent 9:16 quality pixels
 * even for 1:1 — those 720x1280 / 1080x1920 pairs are ignored when the
 * ratio is not 9:16.
 */
export function resolveCanvasFromDto(dto: {
  aspectRatio?: string | null;
  exportWidth?: number | null;
  exportHeight?: number | null;
  exportQuality?: string | null;
  canvasFit?: string | null;
  backgroundColor?: string | null;
}): CanvasTarget {
  const ratio = parseCanvasRatio(dto.aspectRatio);
  const ew = Number(dto.exportWidth || 0);
  const eh = Number(dto.exportHeight || 0);
  const looksLike916Preset =
    (ew === 720 && eh === 1280) || (ew === 1080 && eh === 1920);
  const quality =
    dto.exportQuality != null && String(dto.exportQuality).trim()
      ? parseCanvasQuality(dto.exportQuality)
      : inferQualityFromDims(ew, eh);
  const table = resolveCanvasDims(ratio, quality);
  let w = table.w;
  let h = table.h;
  if (ew > 0 && eh > 0 && !(looksLike916Preset && ratio !== '9:16')) {
    w = evenPx(ew);
    h = evenPx(eh);
  }
  return {
    w,
    h,
    fit: parseCanvasFit(dto.canvasFit),
    backgroundHex: normalizeBackgroundHex(dto.backgroundColor),
  };
}

export function buildCanvasVideoFilter(opts: {
  width: number;
  height: number;
  fit?: CanvasFit;
  backgroundHex?: string;
  fps?: number | null;
}): string {
  const w = evenPx(opts.width);
  const h = evenPx(opts.height);
  const fit = opts.fit === 'fit' ? 'fit' : 'fill';
  const parts: string[] = [];
  if (fit === 'fill') {
    parts.push(
      `scale=${w}:${h}:force_original_aspect_ratio=increase`,
      `crop=${w}:${h}:(iw-${w})/2:(ih-${h})/2`,
    );
  } else {
    parts.push(
      `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:${ffmpegPadColor(opts.backgroundHex || '#000000')}`,
    );
  }
  if (opts.fps != null && Number(opts.fps) > 0) {
    parts.push(`fps=${Number(opts.fps)}`);
  }
  parts.push('setsar=1', 'format=yuv420p');
  return parts.join(',');
}

export function shortsShouldTranscode(dto: {
  soundUrl?: string;
  beautyLevel?: number;
  speedFactor?: number;
  filterId?: string;
  aspectRatio?: string;
  trimStartSec?: number;
  trimEndSec?: number;
  /** Client-reported source duration (seconds); used to detect real trim vs full-range defaults. */
  duration?: number;
  overlayText?: string;
  overlayItems?: Array<{ text?: string }>;
  originalVolume?: number;
  musicVolume?: number;
  splitPoints?: number[];
  transitionId?: string;
  exportWidth?: number;
  exportHeight?: number;
  exportFps?: number;
  exportQuality?: string;
  canvasFit?: string;
  backgroundColor?: string;
  clips?: Array<{ fileIndex?: number; type?: string }>;
  watermark?: boolean;
  composition?: string;
  layoutId?: string;
  stickers?: Array<{ catalogId?: string }>;
}): boolean {
  if (process.env.SHORTS_DISABLE_FFMPEG === '1') return false;
  if (dto.watermark !== false) return true;
  if (Array.isArray(dto.clips) && dto.clips.length > 1) return true;
  const ar = String(dto.aspectRatio || '').trim();
  if (ar && ar !== '9:16') return true;
  if (String(dto.composition || '').toLowerCase() === 'collage') return true;
  if (Array.isArray(dto.stickers) && dto.stickers.length > 0) return true;
  if (parseCanvasFit(dto.canvasFit) === 'fit') return true;
  const bg = normalizeBackgroundHex(dto.backgroundColor);
  if (bg !== '#000000') return true;
  const sound = dto.soundUrl != null && String(dto.soundUrl).trim().length > 0;
  if (sound) return true;
  const beauty = dto.beautyLevel != null && Number(dto.beautyLevel) > 0;
  if (beauty) return true;
  const sp = dto.speedFactor != null ? Number(dto.speedFactor) : 1;
  if (sp > 0 && Math.abs(sp - 1) > 0.001) return true;
  const fid = dto.filterId != null ? String(dto.filterId).trim() : '';
  if (fid && fid !== 'none') return true;
  const trimStart = Number(dto.trimStartSec || 0);
  const trimEnd = Number(dto.trimEndSec || 0);
  const reportedDur = Number(dto.duration || 0);
  /** Trim only forces transcode when it actually shortens vs reported duration (client always sends trim range). */
  const trimCutsIn =
    trimStart > 0.08 ||
    (reportedDur > 1 &&
      trimEnd > 0 &&
      trimEnd < reportedDur - 0.12);
  if (trimCutsIn) return true;
  if (String(dto.overlayText || '').trim()) return true;
  if (
    Array.isArray(dto.overlayItems) &&
    dto.overlayItems.some((x) => String(x?.text || '').trim())
  ) {
    return true;
  }
  const ov = Number(dto.originalVolume ?? 1);
  if (Number.isFinite(ov) && Math.abs(ov - 1) > 0.001) return true;
  const mv = Number(dto.musicVolume ?? 1);
  if (Number.isFinite(mv) && Math.abs(mv - 1) > 0.001) return true;
  if (Array.isArray(dto.splitPoints) && dto.splitPoints.length > 0) return true;
  const tid = String(dto.transitionId || '').toLowerCase();
  if (tid && tid !== 'none') return true;
  const ew = Number(dto.exportWidth || 0);
  const eh = Number(dto.exportHeight || 0);
  if (ew > 0 && eh > 0) return true;
  const ef = Number(dto.exportFps || 0);
  if (Number.isFinite(ef) && ef > 0) return true;
  return false;
}

export function buildShortsVideoFilters(opts: {
  filterId?: string | null;
  beautyLevel?: number | null;
  speedFactor?: number | null;
}): string {
  const parts: string[] = [];
  const speed =
    opts.speedFactor != null && opts.speedFactor > 0 ? opts.speedFactor : 1;
  if (Math.abs(speed - 1) > 0.001) {
    parts.push(`setpts=PTS/${speed}`);
  }
  const id =
    opts.filterId != null ? String(opts.filterId).trim() : 'none';
  const overlay = id && id !== 'none' ? FILTER_OVERLAY[id] : undefined;
  if (overlay) {
    const grade = buildOverlayColorGrade(overlay.hex, overlay.opacity);
    if (grade) parts.push(grade);
  } else if (id && id !== 'none') {
    parts.push(FILTER_FALLBACK_VF);
  }
  const b = opts.beautyLevel != null ? Number(opts.beautyLevel) : 0;
  if (Number.isFinite(b) && b > 0) {
    const t = Math.min(100, Math.max(0, b)) / 100;
    const sigma = 0.12 + t * 2.8;
    parts.push(`gblur=sigma=${sigma.toFixed(2)}`);
    parts.push('unsharp=5:5:0.7:5:5:0.02');
  }
  return parts.filter(Boolean).join(',');
}

/** atempo must stay in (0.5, 2); chain for larger factors */
export function buildAtempoChain(factor: number): string {
  if (factor <= 0) return 'anull';
  const chain: string[] = [];
  let f = factor;
  while (f > 2 + 1e-6) {
    chain.push('atempo=2.0');
    f /= 2;
  }
  while (f < 0.5 - 1e-6) {
    chain.push('atempo=0.5');
    f /= 0.5;
  }
  chain.push(`atempo=${Math.min(2, Math.max(0.5, f)).toFixed(4)}`);
  return chain.join(',');
}
