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

export function shortsShouldTranscode(dto: {
  soundUrl?: string;
  beautyLevel?: number;
  speedFactor?: number;
  filterId?: string;
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
  clips?: Array<{ fileIndex?: number; type?: string }>;
  watermark?: boolean;
}): boolean {
  if (process.env.SHORTS_DISABLE_FFMPEG === '1') return false;
  if (dto.watermark !== false) return true;
  if (Array.isArray(dto.clips) && dto.clips.length > 1) return true;
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
