import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { CreateShortDto } from './dto/shorts.dto';
import {
  buildAtempoChain,
  buildCanvasVideoFilter,
  buildShortsVideoFilters,
  resolveCanvasFromDto,
  type CanvasTarget,
} from './shorts-ffmpeg-presets';

async function unlinkQuiet(p: string | null | undefined) {
  if (!p) return;
  try {
    await fs.unlink(p);
  } catch {
    /* noop */
  }
}

/** Override when FFmpeg is not named `ffmpeg` on PATH (e.g. snap: `/snap/bin/ffmpeg`). */
function ffmpegBin(): string {
  const v = process.env.FFMPEG_BIN?.trim();
  return v || 'ffmpeg';
}

/**
 * Override when `ffprobe` is not on PATH (e.g. snap: `/snap/bin/ffmpeg.ffprobe`).
 */
function ffprobeBin(): string {
  const v = process.env.FFPROBE_BIN?.trim();
  return v || 'ffprobe';
}

@Injectable()
export class ShortsTranscodeService {
  private readonly logger = new Logger(ShortsTranscodeService.name);

  constructor(private readonly http: HttpService) {}

  shouldProcess(dto: CreateShortDto): boolean {
    if (process.env.SHORTS_DISABLE_FFMPEG === '1') {
      if (dto.soundUrl?.trim()) {
        throw new BadRequestException(
          'Music export is temporarily unavailable. Please retry later.',
        );
      }
      return false;
    }
    // Always transcode so the Eatwaze logo is burned into the published file.
    return true;
  }

  async process(videoBuffer: Buffer, dto: CreateShortDto): Promise<Buffer> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const inPath = path.join(os.tmpdir(), `eatix-sh-in-${id}.mp4`);
    const outPath = path.join(os.tmpdir(), `eatix-sh-out-${id}.mp4`);
    const mergedPath = path.join(os.tmpdir(), `eatix-sh-merged-${id}.mp4`);
    let soundPath: string | null = null;
    let subtitlesAssPath: string | null = null;
    let segmentPaths: string[] = [];
    let workPath = inPath;
    let cleanupMerged = false;
    try {
      await this.assertFfmpegAvailable();
      await fs.writeFile(inPath, videoBuffer);
      const sourceMeta = await this.probeVideoMeta(inPath);
      const hasAudio = await this.probeHasAudio(inPath);
      const trimS =
        dto.trimStartSec != null && Number(dto.trimStartSec) > 0
          ? Number(dto.trimStartSec)
          : 0;
      let trimE =
        dto.trimEndSec != null && Number(dto.trimEndSec) > trimS
          ? Number(dto.trimEndSec)
          : 0;
      if (!trimE || trimE > sourceMeta.durationSec) {
        trimE = sourceMeta.durationSec;
      }
      const splits = this.normalizeSplitPoints(dto.splitPoints, trimS, trimE);
      const ranges = this.buildSegmentRanges(trimS, trimE, splits);

      if (ranges.length > 1) {
        segmentPaths = await this.extractSegmentFiles(
          inPath,
          ranges,
          id,
          hasAudio,
        );
        const trans = String(dto.transitionId || 'none').toLowerCase();
        const transDur = Math.min(
          1.5,
          Math.max(0.05, Number(dto.transitionDurationSec) || 0.25),
        );
        try {
          if (trans === 'fade') {
            await this.xfadeMergeSegments(
              segmentPaths,
              mergedPath,
              transDur,
              hasAudio,
            );
          } else {
            await this.concatDemuxerReencode(segmentPaths, mergedPath);
          }
        } catch (e) {
          this.logger.warn(
            `Segment merge failed (${(e as Error)?.message}), falling back to hard concat`,
          );
          await this.concatDemuxerReencode(segmentPaths, mergedPath);
        }
        await this.unlinkPaths(segmentPaths);
        segmentPaths = [];
        workPath = mergedPath;
        cleanupMerged = true;
      }

      const workMeta = await this.probeVideoMeta(workPath);
      if (dto.soundUrl?.trim()) {
        soundPath = await this.downloadSound(dto.soundUrl.trim(), id);
      }
      const speed =
        dto.speedFactor != null && dto.speedFactor > 0
          ? Number(dto.speedFactor)
          : 1;
      const vf = buildShortsVideoFilters({
        filterId: dto.filterId,
        beautyLevel: dto.beautyLevel,
        speedFactor: speed,
      });
      const exportTarget = this.resolveEffectiveExportTarget(dto);
      const exportSuffix = this.buildExportVideoSuffix(
        exportTarget.w,
        exportTarget.h,
        dto.exportFps,
        workMeta.width,
        workMeta.height,
        exportTarget.fit !== 'fit',
        exportTarget.backgroundHex,
      );
      if (
        Array.isArray(dto.overlayItems) &&
        dto.overlayItems.some((x) => String(x?.text || '').trim())
      ) {
        subtitlesAssPath = path.join(os.tmpdir(), `eatix-sh-ass-${id}.ass`);
        const assDoc = this.buildAssFromOverlayItems({
          items: dto.overlayItems,
          width: workMeta.width,
          height: workMeta.height,
          durationSec: workMeta.durationSec,
          trimStartSec: trimS,
          trimEndSec: trimE,
          outputDurationSec: workMeta.durationSec,
        });
        await fs.writeFile(subtitlesAssPath, assDoc, 'utf8');
      }
      const useMerged = ranges.length > 1;
      const args = this.composeFfmpegArgs({
        inPath: workPath,
        outPath,
        soundPath,
        vf,
        speed,
        hasAudio,
        trimStartSec: useMerged ? undefined : dto.trimStartSec,
        trimEndSec: useMerged ? undefined : dto.trimEndSec,
        overlayText: dto.overlayText,
        overlayTextColor: dto.overlayTextColor,
        overlayTextSize: dto.overlayTextSize,
        overlayTextX: dto.overlayTextX,
        overlayTextY: dto.overlayTextY,
        overlayItems: dto.overlayItems,
        subtitlesAssPath,
        originalVolume: dto.originalVolume,
        musicVolume: dto.musicVolume,
        exportVideoSuffix: exportSuffix,
      });
      if (args.length === 0) {
        if (dto.watermark === false) {
          return await fs.readFile(inPath);
        }
        const wmOnly = path.join(os.tmpdir(), `eatix-sh-wm-${id}.mp4`);
        await this.applyWatermark(inPath, wmOnly);
        const buf = await fs.readFile(wmOnly);
        await unlinkQuiet(wmOnly);
        return buf;
      }
      await this.runFfmpeg(args);
      if (dto.watermark === false) {
        return await fs.readFile(outPath);
      }
      const wmPath = path.join(os.tmpdir(), `eatix-sh-wm-${id}.mp4`);
      await this.applyWatermark(outPath, wmPath);
      const outBuf = await fs.readFile(wmPath);
      await unlinkQuiet(wmPath);
      return outBuf;
    } finally {
      await this.unlinkPaths(segmentPaths);
      await unlinkQuiet(inPath);
      await unlinkQuiet(outPath);
      if (cleanupMerged) await unlinkQuiet(mergedPath);
      await unlinkQuiet(soundPath);
      await unlinkQuiet(subtitlesAssPath ?? undefined);
    }
  }

  /**
   * Process a local file path (avoids buffering the whole input in memory).
   * Returns the processed MP4 file path (caller is responsible for deleting it).
   */
  async processFile(
    inputPath: string,
    dto: CreateShortDto,
    extraClipFiles: Express.Multer.File[] = [],
  ): Promise<string> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const outPath = path.join(os.tmpdir(), `eatix-sh-out-${id}.mp4`);
    const wmPath = path.join(os.tmpdir(), `eatix-sh-wm-${id}.mp4`);
    const mergedPath = path.join(os.tmpdir(), `eatix-sh-merged-${id}.mp4`);
    const stillPath = path.join(os.tmpdir(), `eatix-sh-still-${id}.mp4`);
    let soundPath: string | null = null;
    let subtitlesAssPath: string | null = null;
    let segmentPaths: string[] = [];
    let workPath = inputPath;
    let cleanupMerged = false;
    let cleanupStill = false;
    let clipsMergedPath: string | null = null;
    try {
      await this.assertFfmpegAvailable();
      const clipsMeta = Array.isArray(dto.clips) ? dto.clips : [];
      const clipFiles =
        extraClipFiles?.length > 0
          ? extraClipFiles
          : [{ path: inputPath, mimetype: 'video/mp4' } as Express.Multer.File];
      const timelineMeta =
        clipsMeta.length > 0
          ? clipsMeta
          : clipFiles.length > 1
            ? clipFiles.map((_, i) => ({
                fileIndex: i,
                type: String(clipFiles[i]?.mimetype || '').startsWith('image/')
                  ? 'photo'
                  : 'video',
              }))
            : [];
      const canvas = resolveCanvasFromDto(dto);
      if (timelineMeta.length > 0 && clipFiles.length > 0) {
        this.logger.log(
          `Joining ${timelineMeta.length} clip(s) from ${clipFiles.length} file(s) into one video`,
        );
        clipsMergedPath = await this.buildTimelineFromClips(
          clipFiles,
          timelineMeta,
          id,
          canvas,
        );
        workPath = clipsMergedPath;
        cleanupMerged = true;
      } else if (this.isImageSource(inputPath, dto)) {
        const dur = Math.max(
          0.5,
          Number(dto.trimEndSec || dto.duration || 3) -
            Number(dto.trimStartSec || 0) || 3,
        );
        await this.stillToVideo(inputPath, stillPath, dur, canvas);
        workPath = stillPath;
        cleanupStill = true;
      }
      const skipSourceTrim = Boolean(clipsMergedPath);
      const sourceMeta = await this.probeVideoMeta(workPath);
      const hasAudio = await this.probeHasAudio(workPath);
      const trimS = skipSourceTrim
        ? 0
        : dto.trimStartSec != null && Number(dto.trimStartSec) > 0
          ? Number(dto.trimStartSec)
          : 0;
      let trimE = skipSourceTrim
        ? sourceMeta.durationSec
        : dto.trimEndSec != null && Number(dto.trimEndSec) > trimS
          ? Number(dto.trimEndSec)
          : 0;
      if (!trimE || trimE > sourceMeta.durationSec) {
        trimE = sourceMeta.durationSec;
      }
      const splits = skipSourceTrim
        ? []
        : this.normalizeSplitPoints(dto.splitPoints, trimS, trimE);
      const ranges = this.buildSegmentRanges(trimS, trimE, splits);

      if (ranges.length > 1) {
        segmentPaths = await this.extractSegmentFiles(
          workPath,
          ranges,
          id,
          hasAudio,
        );
        const trans = String(dto.transitionId || 'none').toLowerCase();
        const transDur = Math.min(
          1.5,
          Math.max(0.05, Number(dto.transitionDurationSec) || 0.25),
        );
        try {
          if (trans === 'fade') {
            await this.xfadeMergeSegments(
              segmentPaths,
              mergedPath,
              transDur,
              hasAudio,
            );
          } else {
            await this.concatDemuxerReencode(segmentPaths, mergedPath);
          }
        } catch (e) {
          this.logger.warn(
            `Segment merge failed (${(e as Error)?.message}), falling back to hard concat`,
          );
          await this.concatDemuxerReencode(segmentPaths, mergedPath);
        }
        await this.unlinkPaths(segmentPaths);
        segmentPaths = [];
        workPath = mergedPath;
        cleanupMerged = true;
      }

      const workMeta = await this.probeVideoMeta(workPath);
      if (dto.soundUrl?.trim()) {
        soundPath = await this.downloadSound(dto.soundUrl.trim(), id);
      }
      const speed = skipSourceTrim
        ? 1
        : dto.speedFactor != null && dto.speedFactor > 0
          ? Number(dto.speedFactor)
          : 1;
      const vf = buildShortsVideoFilters({
        filterId: dto.filterId,
        beautyLevel: dto.beautyLevel,
        speedFactor: speed,
      });
      const exportTarget = this.resolveEffectiveExportTarget(dto);
      const exportSuffix = this.buildExportVideoSuffix(
        exportTarget.w,
        exportTarget.h,
        dto.exportFps,
        workMeta.width,
        workMeta.height,
        exportTarget.fit !== 'fit',
        exportTarget.backgroundHex,
      );
      if (
        Array.isArray(dto.overlayItems) &&
        dto.overlayItems.some((x) => String(x?.text || '').trim())
      ) {
        subtitlesAssPath = path.join(os.tmpdir(), `eatix-sh-ass-${id}.ass`);
        const assDoc = this.buildAssFromOverlayItems({
          items: dto.overlayItems,
          width: workMeta.width,
          height: workMeta.height,
          durationSec: workMeta.durationSec,
          trimStartSec: trimS,
          trimEndSec: trimE,
          outputDurationSec: workMeta.durationSec,
        });
        await fs.writeFile(subtitlesAssPath, assDoc, 'utf8');
      }
      const useMerged = ranges.length > 1 || skipSourceTrim;
      const args = this.composeFfmpegArgs({
        inPath: workPath,
        outPath,
        soundPath,
        vf,
        speed,
        hasAudio,
        trimStartSec: useMerged ? undefined : dto.trimStartSec,
        trimEndSec: useMerged ? undefined : dto.trimEndSec,
        overlayText: dto.overlayText,
        overlayTextColor: dto.overlayTextColor,
        overlayTextSize: dto.overlayTextSize,
        overlayTextX: dto.overlayTextX,
        overlayTextY: dto.overlayTextY,
        overlayItems: dto.overlayItems,
        subtitlesAssPath,
        originalVolume: dto.originalVolume,
        musicVolume: dto.musicVolume,
        exportVideoSuffix: exportSuffix,
      });
    const wantsWatermark = dto.watermark !== false;
    const encodedPath = args.length === 0 ? workPath : outPath;
      if (args.length > 0) {
        await this.runFfmpeg(args);
      }
      if (!wantsWatermark) {
        if (encodedPath === wmPath) return wmPath;
        if (encodedPath === outPath) return outPath;
        await fs.copyFile(encodedPath, wmPath);
        return wmPath;
      }
      await this.applyWatermark(encodedPath, wmPath);
      return wmPath;
    } finally {
      await this.unlinkPaths(segmentPaths);
      if (cleanupMerged) await unlinkQuiet(mergedPath);
      if (cleanupStill) await unlinkQuiet(stillPath);
      if (clipsMergedPath && clipsMergedPath !== mergedPath) {
        await unlinkQuiet(clipsMergedPath);
      }
      await unlinkQuiet(soundPath);
      await unlinkQuiet(subtitlesAssPath ?? undefined);
    }
  }

  private async resolveWatermarkLogo(): Promise<string | null> {
    const envPath = String(process.env.EATWAZE_WATERMARK_PATH || '').trim();
    const candidates = [
      envPath || null,
      path.join(process.cwd(), 'assets', 'eatwaze-watermark.png'),
      path.join(__dirname, '..', '..', 'assets', 'eatwaze-watermark.png'),
      path.join(__dirname, '..', '..', '..', 'assets', 'eatwaze-watermark.png'),
      path.join(
        process.cwd(),
        '..',
        'Ethics-app',
        'src',
        'assets',
        'logo.png',
      ),
    ].filter(Boolean) as string[];
    for (const p of candidates) {
      try {
        await fs.access(p);
        return p;
      } catch {
        /* try next */
      }
    }
    this.logger.error(
      `Eatwaze watermark PNG not found. Tried: ${candidates.join(' | ')}`,
    );
    return null;
  }

  /**
   * Phone videos often store landscape pixels + rotate metadata.
   * filter_complex does not always autorotate, so a "top-right" overlay
   * can appear bottom-right after players apply rotation. Bake orientation first.
   */
  private async probeDisplayRotationDeg(inputPath: string): Promise<number> {
    return new Promise((resolve) => {
      const p = spawn(
        ffprobeBin(),
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream_tags=rotate:stream_side_data=rotation',
          '-of',
          'json',
          inputPath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      p.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      p.on('error', () => resolve(0));
      p.on('close', () => {
        try {
          const j = JSON.parse(out) as {
            streams?: Array<{
              tags?: { rotate?: string };
              side_data_list?: Array<{ rotation?: number | string }>;
            }>;
          };
          const stream = j.streams?.[0];
          const tag = Number(stream?.tags?.rotate);
          if (Number.isFinite(tag) && tag !== 0) {
            resolve(((Math.round(tag) % 360) + 360) % 360);
            return;
          }
          const side = stream?.side_data_list || [];
          for (const s of side) {
            const r = Number(s?.rotation);
            if (Number.isFinite(r) && r !== 0) {
              // Display matrix rotation is often negative (e.g. -90).
              resolve(((Math.round(-r) % 360) + 360) % 360);
              return;
            }
          }
        } catch {
          /* ignore */
        }
        resolve(0);
      });
    });
  }

  /** FFmpeg filter prefix that uprights the coded frame (empty if already upright). */
  private orientationFilterPrefix(rotationDeg: number): string {
    const r = ((Math.round(rotationDeg) % 360) + 360) % 360;
    if (r === 90) return 'transpose=1,'; // 90° CW
    if (r === 180) return 'hflip,vflip,';
    if (r === 270) return 'transpose=2,'; // 90° CCW
    return '';
  }

  async applyWatermark(inPath: string, outPath: string): Promise<void> {
    const logo = await this.resolveWatermarkLogo();
    const hasAudio = await this.probeHasAudio(inPath);
    const rotation = await this.probeDisplayRotationDeg(inPath);
    const orient = this.orientationFilterPrefix(rotation);
    // Exact middle-center — logo only (transparent PNG, no box/border).
    // Must stay centered on the published file (not only create-preview UI).
    const overlay =
      `[0:v]${orient}format=yuv420p[base];` +
      '[1:v]scale=280:-1,format=rgba[wm];' +
      '[base][wm]overlay=(W-w)/2:(H-h)/2';
    this.logger.log(
      `Burning Eatwaze watermark CENTER (rotation=${rotation}° logo=${logo || 'drawtext'})`,
    );
    if (logo) {
      try {
        // Do not use -shortest with a still PNG: that would cut the video to 1 frame.
        await this.runFfmpeg([
          '-y',
          '-noautorotate',
          '-i',
          inPath,
          '-i',
          logo,
          '-filter_complex',
          overlay,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          ...(hasAudio
            ? (['-c:a', 'aac', '-b:a', '192k'] as string[])
            : (['-an'] as string[])),
          '-movflags',
          '+faststart',
          '-metadata:s:v:0',
          'rotate=0',
          outPath,
        ]);
        this.logger.log('Eatwaze CENTER watermark applied to video');
        return;
      } catch (e) {
        this.logger.warn(
          `Logo overlay failed, falling back to text: ${(e as Error)?.message}`,
        );
      }
    }
    // Text fallback: no box — just the wordmark, centered.
    const textVf = `${orient}drawtext=text='eatwaze':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=(h-text_h)/2`;
    await this.runFfmpeg([
      '-y',
      '-noautorotate',
      '-i',
      inPath,
      '-vf',
      textVf,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      ...(hasAudio
        ? (['-c:a', 'aac', '-b:a', '192k'] as string[])
        : (['-an'] as string[])),
      '-movflags',
      '+faststart',
      '-metadata:s:v:0',
      'rotate=0',
      outPath,
    ]);
    this.logger.log('Eatwaze CENTER text watermark applied to video');
  }

  async applyWatermarkToImage(inPath: string, outPath: string): Promise<void> {
    const logo = await this.resolveWatermarkLogo();
    if (!logo) {
      await fs.copyFile(inPath, outPath);
      return;
    }
    const rotation = await this.probeDisplayRotationDeg(inPath);
    const orient = this.orientationFilterPrefix(rotation);
    this.logger.log(`Burning Eatwaze watermark CENTER on image (rotation=${rotation}°)`);
    await this.runFfmpeg([
      '-y',
      '-noautorotate',
      '-i',
      inPath,
      '-i',
      logo,
      '-filter_complex',
      `[0:v]${orient}format=rgba[base];` +
        '[1:v]scale=220:-1,format=rgba[wm];' +
        '[base][wm]overlay=(W-w)/2:(H-h)/2',
      '-frames:v',
      '1',
      '-q:v',
      '3',
      outPath,
    ]);
  }

  private isImageSource(inputPath: string, dto?: CreateShortDto): boolean {
    const lower = String(inputPath || '').toLowerCase();
    if (/\.(jpg|jpeg|png|webp|heic)$/.test(lower)) return true;
    const first = Array.isArray(dto?.clips) ? dto.clips[0] : null;
    return String(first?.type || '').toLowerCase() === 'photo';
  }

  private clipCanvasFilter(canvas?: Partial<CanvasTarget> | null): string {
    const w = canvas?.w || 1080;
    const h = canvas?.h || 1920;
    return buildCanvasVideoFilter({
      width: w,
      height: h,
      fit: canvas?.fit === 'fit' ? 'fit' : 'fill',
      backgroundHex: canvas?.backgroundHex || '#000000',
      fps: 30,
    });
  }

  private async stillToVideo(
    imagePath: string,
    outPath: string,
    durationSec: number,
    canvas?: Partial<CanvasTarget>,
  ): Promise<void> {
    const dur = Math.max(0.05, Math.min(32, Number(durationSec) || 3));
    await this.runFfmpeg([
      '-y',
      '-loop',
      '1',
      '-t',
      String(dur),
      '-i',
      imagePath,
      '-f',
      'lavfi',
      '-t',
      String(dur),
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-vf',
      this.clipCanvasFilter(canvas),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-shortest',
      '-movflags',
      '+faststart',
      outPath,
    ]);
  }

  private async extractClipSegment(
    inputPath: string,
    outPath: string,
    meta: {
      type?: string;
      trimStartSec?: number;
      trimEndSec?: number;
      speedFactor?: number;
      durationSec?: number;
      volume?: number;
    },
    isPhoto: boolean,
    canvas?: Partial<CanvasTarget>,
  ): Promise<void> {
    if (isPhoto) {
      const dur = Math.max(
        0.05,
        (Number(meta.trimEndSec || meta.durationSec || 3) -
          Number(meta.trimStartSec || 0)) /
          Math.max(0.25, Number(meta.speedFactor) || 1),
      );
      await this.stillToVideo(inputPath, outPath, dur, canvas);
      return;
    }
    const ts = Number(meta.trimStartSec || 0);
    const te = Number(meta.trimEndSec || 0);
    const speed = Math.max(0.25, Number(meta.speedFactor || 1));
    const span =
      te > ts
        ? te - ts
        : Math.max(0.5, Number(meta.durationSec || 3) - ts);
    const outDur = Math.max(0.05, span / speed);
    const vfParts = [];
    if (Math.abs(speed - 1) > 0.001) vfParts.push(`setpts=PTS/${speed}`);
    vfParts.push(this.clipCanvasFilter(canvas));
    const vf = vfParts.join(',');
    const hasAudio = await this.probeHasAudio(inputPath);
    const args: string[] = ['-y'];
    if (ts > 0.02) args.push('-ss', String(ts));
    args.push('-t', String(span), '-i', inputPath);
    if (!hasAudio) {
      args.push(
        '-f',
        'lavfi',
        '-t',
        String(outDur),
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=44100',
      );
    }
    args.push('-vf', vf);
    if (hasAudio) {
      args.push(
        '-af',
        `${buildAtempoChain(speed)},volume=${this.clampVolume(meta.volume, 1)},apad,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo`,
      );
    }
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-t',
      String(outDur),
      '-movflags',
      '+faststart',
      outPath,
    );
    await this.runFfmpeg(args);
  }

  private async buildTimelineFromClips(
    clipFiles: Express.Multer.File[],
    clipsMeta: Array<{
      fileIndex?: number;
      type?: string;
      trimStartSec?: number;
      trimEndSec?: number;
      speedFactor?: number;
      durationSec?: number;
      volume?: number;
    }>,
    id: string,
    canvas?: Partial<CanvasTarget>,
  ): Promise<string> {
    const segs: string[] = [];
    try {
      for (let i = 0; i < clipsMeta.length; i += 1) {
        const meta = clipsMeta[i];
        const fileIdx = Number(meta.fileIndex);
        const file = clipFiles[Number.isFinite(fileIdx) ? fileIdx : 0];
        const src = file?.path;
        if (!src) continue;
        const isPhoto =
          String(meta.type || '').toLowerCase() === 'photo' ||
          String(file?.mimetype || '').startsWith('image/');
        const out = path.join(os.tmpdir(), `eatix-sh-clip-${id}-${i}.mp4`);
        await this.extractClipSegment(src, out, meta, isPhoto, canvas);
        segs.push(out);
      }
      if (!segs.length) {
        throw new Error('No clips to merge');
      }
      const merged = path.join(os.tmpdir(), `eatix-sh-clips-${id}.mp4`);
      if (segs.length === 1) {
        await fs.copyFile(segs[0], merged);
      } else {
        await this.concatDemuxerReencode(segs, merged);
      }
      return merged;
    } finally {
      await this.unlinkPaths(segs);
    }
  }

  private normalizeSplitPoints(
    raw: number[] | undefined,
    trimS: number,
    trimE: number,
  ): number[] {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const lo = trimS + 0.08;
    const hi = trimE - 0.08;
    const seen = new Set<number>();
    const out: number[] = [];
    for (const x of raw) {
      const t = Number(x);
      if (!Number.isFinite(t) || t <= lo || t >= hi) continue;
      const k = Math.round(t * 1000) / 1000;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  private buildSegmentRanges(
    trimS: number,
    trimE: number,
    splits: number[],
  ): Array<{ start: number; end: number }> {
    const bounds = [trimS, ...splits, trimE];
    const ranges: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const start = bounds[i];
      const end = bounds[i + 1];
      if (end - start >= 0.04) {
        ranges.push({ start, end });
      }
    }
    if (ranges.length === 0) {
      ranges.push({ start: trimS, end: trimE });
    }
    return ranges;
  }

  private async extractSegmentFiles(
    inputPath: string,
    ranges: Array<{ start: number; end: number }>,
    id: string,
    withAudio: boolean,
  ): Promise<string[]> {
    const paths: string[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const { start, end } = ranges[i];
      const dur = Math.max(0.05, end - start);
      const out = path.join(os.tmpdir(), `eatix-sh-seg-${id}-${i}.mp4`);
      const args = [
        '-y',
        '-i',
        inputPath,
        '-ss',
        String(start),
        '-t',
        String(dur),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        ...(withAudio
          ? ['-c:a', 'aac', '-b:a', '192k']
          : ['-an']),
        out,
      ];
      await this.runFfmpeg(args);
      paths.push(out);
    }
    return paths;
  }

  private async concatDemuxerReencode(
    segPaths: string[],
    outPath: string,
  ): Promise<void> {
    const listPath = path.join(
      os.tmpdir(),
      `eatix-sh-concatlist-${Date.now()}.txt`,
    );
    const lines = segPaths.map((p) => {
      const abs = path.resolve(p).replace(/\\/g, '/');
      return `file '${abs.replace(/'/g, "'\\''")}'`;
    });
    await fs.writeFile(listPath, `${lines.join('\n')}\n`, 'utf8');
    let anyAudio = false;
    for (const p of segPaths) {
      if (await this.probeHasAudio(p)) {
        anyAudio = true;
        break;
      }
    }
    const args = [
      '-y',
      '-fflags',
      '+genpts',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      ...(anyAudio
        ? (['-c:a', 'aac', '-b:a', '192k'] as const)
        : (['-an'] as const)),
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outPath,
    ];
    try {
      await this.runFfmpeg(args);
    } finally {
      await unlinkQuiet(listPath);
    }
  }

  private async xfadeMergeSegments(
    segPaths: string[],
    outPath: string,
    transSec: number,
    sourceHadAudio: boolean,
  ): Promise<void> {
    if (segPaths.length === 0) {
      throw new Error('xfadeMergeSegments: no segments');
    }
    if (segPaths.length === 1) {
      await fs.copyFile(segPaths[0], outPath);
      return;
    }
    const durs: number[] = [];
    for (const p of segPaths) {
      const m = await this.probeVideoMeta(p);
      durs.push(Math.max(0.02, m.durationSec));
    }
    const d = Math.min(
      transSec,
      Math.min(...durs) * 0.85,
      durs[0] * 0.85,
    );
    const inputs: string[] = [];
    for (const p of segPaths) {
      inputs.push('-i', p);
    }

    let accDur = durs[0];
    let vIn = '0:v';
    let fc = '';
    for (let i = 1; i < segPaths.length; i++) {
      const offset = Math.max(0, accDur - d);
      const vOut = i === segPaths.length - 1 ? 'vout' : `vx${i}`;
      fc += `[${vIn}][${i}:v]xfade=transition=fade:duration=${d.toFixed(4)}:offset=${offset.toFixed(4)}[${vOut}];`;
      vIn = vOut;
      accDur = accDur + durs[i] - d;
    }

    if (!sourceHadAudio) {
      const args = [
        '-y',
        ...inputs,
        '-filter_complex',
        fc.replace(/;$/, ''),
        '-map',
        '[vout]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-movflags',
        '+faststart',
        outPath,
      ];
      await this.runFfmpeg(args);
      return;
    }

    for (const p of segPaths) {
      if (!(await this.probeHasAudio(p))) {
        await this.concatDemuxerReencode(segPaths, outPath);
        return;
      }
    }

    let accA = durs[0];
    let aIn = '0:a';
    for (let i = 1; i < segPaths.length; i++) {
      const aOut = i === segPaths.length - 1 ? 'aout' : `ax${i}`;
      fc += `[${aIn}][${i}:a]acrossfade=d=${d.toFixed(4)}[${aOut}];`;
      aIn = aOut;
      accA = accA + durs[i] - d;
    }

    const args = [
      '-y',
      ...inputs,
      '-filter_complex',
      fc.replace(/;$/, ''),
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outPath,
    ];
    await this.runFfmpeg(args);
  }

  private resolveEffectiveExportTarget(dto: {
    exportWidth?: number;
    exportHeight?: number;
    aspectRatio?: string;
    exportQuality?: string;
    canvasFit?: string;
    backgroundColor?: string;
  }): CanvasTarget {
    return resolveCanvasFromDto(dto);
  }

  /**
   * `cropToFill` (fit=fill): cover/crop. `fit`: contain + pad with background.
   * Matches the editor preview resizeMode cover vs contain.
   */
  private buildExportVideoSuffix(
    w?: number,
    h?: number,
    fps?: number,
    srcW?: number,
    srcH?: number,
    cropToFill = true,
    backgroundHex = '#000000',
  ): string {
    const targetW = w != null && Number(w) > 0 ? Math.round(Number(w)) : 0;
    const targetH = h != null && Number(h) > 0 ? Math.round(Number(h)) : 0;
    const targetFps =
      fps != null && Number(fps) > 0 && Number(fps) <= 120
        ? Number(fps)
        : 0;
    const parts: string[] = [];
    if (targetW > 0 && targetH > 0 && srcW && srcH) {
      const nearly =
        Math.abs(srcW - targetW) / targetW < 0.03 &&
        Math.abs(srcH - targetH) / targetH < 0.03;
      if (!nearly) {
        parts.push(
          buildCanvasVideoFilter({
            width: targetW,
            height: targetH,
            fit: cropToFill ? 'fill' : 'fit',
            backgroundHex,
          }),
        );
      }
    }
    if (targetFps > 0) {
      parts.push(`fps=${targetFps}`);
    }
    return parts.length ? `,${parts.join(',')}` : '';
  }

  private async unlinkPaths(paths: string[]): Promise<void> {
    for (const p of paths) {
      await unlinkQuiet(p);
    }
  }

  private async assertFfmpegAvailable(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpegBin(), ['-hide_banner', '-version'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      p.stderr?.on('data', (d: Buffer) => {
        err += d.toString();
      });
      p.on('error', () =>
        reject(
          new Error(
            'ffmpeg not found. Install ffmpeg and add it to PATH (e.g. brew install ffmpeg / apt install ffmpeg).',
          ),
        ),
      );
      p.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`ffmpeg -version failed: ${err || code}`)),
      );
    });
  }

  private async downloadSound(url: string, id: string): Promise<string> {
    const clean = url.split('?')[0].toLowerCase();
    const ext = clean.endsWith('.wav')
      ? '.wav'
      : clean.endsWith('.m4a')
        ? '.m4a'
        : '.mp3';
    const soundPath = path.join(os.tmpdir(), `eatix-sh-snd-${id}${ext}`);
    const res = await this.http.axiosRef.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxRedirects: 5,
    });
    await fs.writeFile(soundPath, Buffer.from(res.data as ArrayBuffer));
    return soundPath;
  }

  private async probeHasAudio(inputPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn(
        ffprobeBin(),
        [
          '-v',
          'error',
          '-select_streams',
          'a',
          '-show_entries',
          'stream=codec_type',
          '-of',
          'csv=p=0',
          inputPath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      p.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      p.on('error', () => resolve(false));
      p.on('close', (code) => {
        if (code !== 0) resolve(false);
        else resolve(out.trim().length > 0);
      });
    });
  }

  private composeFfmpegArgs(opts: {
    inPath: string;
    outPath: string;
    soundPath: string | null;
    vf: string;
    speed: number;
    hasAudio: boolean;
    trimStartSec?: number;
    trimEndSec?: number;
    overlayText?: string;
    overlayTextColor?: string;
    overlayTextSize?: number;
    overlayTextX?: string;
    overlayTextY?: string;
    overlayItems?: Array<{
      text?: string;
      color?: string;
      size?: number;
      x?: string;
      y?: string;
      xPct?: number;
      yPct?: number;
      startSec?: number;
      endSec?: number;
      rotateDeg?: number;
      shadowPreset?: string;
      anchor?: string;
    }>;
    subtitlesAssPath?: string | null;
    originalVolume?: number;
    musicVolume?: number;
    /** Appended after subtitles/drawtext (scale / fps). */
    exportVideoSuffix?: string;
  }): string[] {
    const {
      inPath,
      outPath,
      soundPath,
      vf,
      speed,
      hasAudio,
      trimStartSec,
      trimEndSec,
      overlayText,
      overlayTextColor,
      overlayTextSize,
      overlayTextX,
      overlayTextY,
      overlayItems,
      subtitlesAssPath,
      originalVolume,
      musicVolume,
      exportVideoSuffix,
    } = opts;
    const base = ['-y'];
    const trimArgs: string[] = [];
    const trimStart =
      trimStartSec != null && Number(trimStartSec) > 0
        ? Number(trimStartSec)
        : 0;
    const trimEnd =
      trimEndSec != null && Number(trimEndSec) > 0 ? Number(trimEndSec) : 0;
    if (trimStart > 0) {
      trimArgs.push('-ss', String(trimStart));
    }
    if (trimEnd > trimStart) {
      trimArgs.push('-to', String(trimEnd));
    }
    const useAss =
      subtitlesAssPath != null && String(subtitlesAssPath).trim().length > 0;
    const drawLayers = useAss ? [] : this.buildDrawtextLayers(overlayItems);
    const drawSingle =
      useAss || drawLayers.length > 0
        ? ''
        : this.buildDrawtext({
            text: overlayText,
            color: overlayTextColor,
            size: overlayTextSize,
            x: overlayTextX,
            y: overlayTextY,
          });
    const subFilter = useAss
      ? `subtitles=${this.escapePathForSubtitlesFilter(subtitlesAssPath!)}`
      : '';
    const ex = String(exportVideoSuffix || '');
    const core = [vf, subFilter, drawSingle, ...drawLayers]
      .filter(Boolean)
      .join(',');
    const vchain = core ? `${core}${ex}` : ex.replace(/^,/, '');
    const ov = this.clampVolume(originalVolume, 1);
    const mv = this.clampVolume(musicVolume, 1);

    if (soundPath) {
      const needReencode =
        Boolean(vchain) ||
        Math.abs(speed - 1) > 0.001 ||
        Math.abs(ov - 1) > 0.001 ||
        Math.abs(mv - 1) > 0.001;
      if (!needReencode && !hasAudio) {
        return [
          ...base,
          ...trimArgs,
          '-i',
          inPath,
          '-stream_loop',
          '-1',
          '-i',
          soundPath,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-shortest',
          '-movflags',
          '+faststart',
          outPath,
        ];
      }
      const videoChain = vchain || `setpts=PTS/${speed}`;
      const audioMix = hasAudio
        ? `[0:a]${buildAtempoChain(speed)},asetpts=PTS-STARTPTS,volume=${ov.toFixed(3)},apad[a0];[1:a]asetpts=PTS-STARTPTS,volume=${mv.toFixed(3)}[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=0:latency=1[a]`
        : `[1:a]volume=${mv.toFixed(3)}[a]`;
      return [
        ...base,
        ...trimArgs,
        '-i',
        inPath,
        '-stream_loop',
        '-1',
        '-i',
        soundPath,
        '-filter_complex',
        `[0:v]${videoChain}[v];${audioMix}`,
        '-map',
        '[v]',
        '-map',
        '[a]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
        '-movflags',
        '+faststart',
        outPath,
      ];
    }

    if (Math.abs(speed - 1) > 0.001 && !hasAudio) {
      const videoChain = vchain || `setpts=PTS/${speed}`;
      return [
        ...base,
        ...trimArgs,
        '-i',
        inPath,
        '-vf',
        videoChain,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-movflags',
        '+faststart',
        outPath,
      ];
    }

    if (Math.abs(speed - 1) > 0.001 && hasAudio) {
      const atempo = buildAtempoChain(speed);
      const videoChain = vchain || `setpts=PTS/${speed}`;
      const aChain =
        Math.abs(ov - 1) > 0.001
          ? `${atempo},volume=${ov.toFixed(3)}`
          : atempo;
      return [
        ...base,
        ...trimArgs,
        '-i',
        inPath,
        '-filter_complex',
        `[0:v]${videoChain}[v];[0:a]${aChain}[a]`,
        '-map',
        '[v]',
        '-map',
        '[a]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outPath,
      ];
    }

    if (vchain || vf) {
      const audioArgs = hasAudio
        ? Math.abs(ov - 1) > 0.001
          ? ['-af', `volume=${ov.toFixed(3)}`, '-c:a', 'aac', '-b:a', '192k']
          : ['-c:a', 'copy']
        : ['-an'];
      return [
        ...base,
        ...trimArgs,
        '-i',
        inPath,
        '-vf',
        vchain || vf,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        ...audioArgs,
        '-movflags',
        '+faststart',
        outPath,
      ];
    }

    /** Trim and/or audio volume without a video filter chain (avoids returning [] and skipping re-encode). */
    const needsTrim = trimStart > 0 || trimEnd > trimStart;
    const needsVol = hasAudio && Math.abs(ov - 1) > 0.001;
    if (needsTrim || needsVol) {
      const audioArgs = hasAudio
        ? needsVol
          ? ['-af', `volume=${ov.toFixed(3)}`, '-c:a', 'aac', '-b:a', '192k']
          : ['-c:a', 'copy']
        : ['-an'];
      return [
        ...base,
        ...trimArgs,
        '-i',
        inPath,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        ...audioArgs,
        '-movflags',
        '+faststart',
        outPath,
      ];
    }

    return [];
  }

  private async probeVideoMeta(inputPath: string): Promise<{
    width: number;
    height: number;
    durationSec: number;
  }> {
    return new Promise((resolve, reject) => {
      const p = spawn(
        ffprobeBin(),
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height',
          '-show_entries',
          'format=duration',
          '-of',
          'json',
          inputPath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      p.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      p.on('error', () =>
        reject(new Error('ffprobe not found — install ffmpeg/ffprobe')),
      );
      p.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe exited ${code}`));
          return;
        }
        try {
          const j = JSON.parse(out) as {
            streams?: Array<{ width?: number; height?: number }>;
            format?: { duration?: string };
          };
          const w = Number(j.streams?.[0]?.width || 1080);
          const h = Number(j.streams?.[0]?.height || 1920);
          const dur = Number(j.format?.duration || 30);
          resolve({
            width: Number.isFinite(w) && w > 0 ? w : 1080,
            height: Number.isFinite(h) && h > 0 ? h : 1920,
            durationSec: Number.isFinite(dur) && dur > 0 ? dur : 30,
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
  }

  private escapePathForSubtitlesFilter(filePath: string): string {
    const normalized = path.resolve(filePath).replace(/\\/g, '/');
    return normalized.replace(/:/g, '\\:');
  }

  private formatAssTime(sec: number): string {
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const whole = Math.floor(s % 60);
    const cs = Math.min(99, Math.round((s - Math.floor(s)) * 100));
    return `${h}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  private hexToAssPrimaryColour(hex: string): string {
    const h = String(hex || '')
      .replace('#', '')
      .trim()
      .toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(h)) return '&H00FFFFFF&';
    const r = h.slice(0, 2);
    const g = h.slice(2, 4);
    const b = h.slice(4, 6);
    return `&H00${b}${g}${r}&`;
  }

  private escapeAssText(raw: string): string {
    return raw
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\n/g, '\\N');
  }

  private assShadowTags(preset?: string): string {
    const p = String(preset || 'soft').toLowerCase();
    if (p === 'none') return '\\bord0\\shad0';
    if (p === 'hard') return '\\bord4\\shad2\\3c&H000000&';
    return '\\bord2\\shad1\\3c&H000000&';
  }

  private assAnFromAnchor(anchor?: string): number {
    const a = String(anchor || 'tl').toLowerCase();
    const map: Record<string, number> = {
      bl: 1,
      bc: 2,
      br: 3,
      cl: 4,
      cc: 5,
      cr: 6,
      tl: 7,
      tc: 8,
      tr: 9,
    };
    return map[a] ?? 7;
  }

  private parseOverlayPctFromExpr(
    axis: 'x' | 'y',
    expr?: string,
  ): number | null {
    if (!expr) return null;
    const s = String(expr);
    if (axis === 'x') {
      const m = s.match(/\(\s*([0-9.]+)\s*\*\s*\(w-text_w\)\s*\)/);
      return m ? Number(m[1]) : null;
    }
    const m = s.match(/\(\s*([0-9.]+)\s*\*\s*\(h-text_h\)\s*\)/);
    return m ? Number(m[1]) : null;
  }

  private buildAssFromOverlayItems(opts: {
    items: Array<{
      text?: string;
      color?: string;
      size?: number;
      x?: string;
      y?: string;
      xPct?: number;
      yPct?: number;
      startSec?: number;
      endSec?: number;
      rotateDeg?: number;
      shadowPreset?: string;
      anchor?: string;
    }>;
    width: number;
    height: number;
    durationSec: number;
    trimStartSec?: number;
    trimEndSec?: number;
    /** Final muxed duration (e.g. after xfade); caps subtitle end vs trim span. */
    outputDurationSec?: number;
  }): string {
    const {
      items,
      width,
      height,
      durationSec,
      trimStartSec,
      trimEndSec,
      outputDurationSec,
    } = opts;
    const trimS =
      trimStartSec != null && Number(trimStartSec) > 0
        ? Number(trimStartSec)
        : 0;
    const trimE =
      trimEndSec != null && Number(trimEndSec) > trimS
        ? Number(trimEndSec)
        : durationSec;
    const outMax =
      outputDurationSec != null &&
      Number(outputDurationSec) > 0 &&
      Number.isFinite(Number(outputDurationSec))
        ? Number(outputDurationSec)
        : trimE - trimS + 10_000;
    const header = [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${width}`,
      `PlayResY: ${height}`,
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Default,DejaVu Sans,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,80,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];
    const lines: string[] = [...header];
    let layerOrder = 0;
    for (const item of items) {
      const text = String(item?.text || '').trim();
      if (!text) continue;
      const xPctRaw =
        item.xPct != null && Number.isFinite(Number(item.xPct))
          ? Number(item.xPct)
          : this.parseOverlayPctFromExpr('x', item.x) ?? 0.5;
      const yPctRaw =
        item.yPct != null && Number.isFinite(Number(item.yPct))
          ? Number(item.yPct)
          : this.parseOverlayPctFromExpr('y', item.y) ?? 0.78;
      const xPct = Math.max(0, Math.min(1, xPctRaw));
      const yPct = Math.max(0, Math.min(1, yPctRaw));
      const px = Math.round(width * xPct);
      const py = Math.round(height * yPct);
      const fs = Math.max(12, Math.min(96, Math.round(Number(item?.size || 36))));
      const ls = Number(item?.startSec ?? 0);
      const le = Number(item?.endSec ?? durationSec);
      const visStart = Math.max(ls, trimS);
      const visEnd = Math.min(le, trimE);
      const assStart = visStart - trimS;
      let assEnd = visEnd - trimS;
      assEnd = Math.min(assEnd, outMax);
      if (assEnd <= assStart + 0.02) continue;
      const colour = this.hexToAssPrimaryColour(String(item?.color || '#FFFFFF'));
      const rot = Number(item?.rotateDeg || 0);
      const frz =
        Number.isFinite(rot) && Math.abs(rot) > 0.05
          ? `\\frz${(-rot).toFixed(2)}`
          : '';
      const shadow = this.assShadowTags(item?.shadowPreset);
      const an = this.assAnFromAnchor(item?.anchor);
      const tags = `{\\an${an}\\pos(${px},${py})\\fs${fs}\\c${colour}${frz}${shadow}}`;
      const escaped = this.escapeAssText(text);
      lines.push(
        `Dialogue: ${layerOrder},${this.formatAssTime(assStart)},${this.formatAssTime(assEnd)},Default,,0,0,0,,${tags}${escaped}`,
      );
      layerOrder += 1;
    }
    if (lines.length <= header.length) {
      lines.push(
        `Dialogue: 0,0:00:00.00,0:00:00.01,Default,,0,0,0,,{\\alpha&HFF&}.`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  private clampVolume(value: number | undefined, fallback: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(2, n));
  }

  private drawtextBoxSuffix(shadowPreset?: string): string {
    const p = String(shadowPreset || 'soft').toLowerCase();
    if (p === 'none') return ':box=0';
    if (p === 'hard')
      return ':box=1:boxcolor=black@0.55:boxborderw=10';
    return ':box=1:boxcolor=black@0.35:boxborderw=8';
  }

  private buildDrawtext(opts: {
    text?: string;
    color?: string;
    size?: number;
    x?: string;
    y?: string;
  }): string {
    const raw = String(opts.text || '').trim();
    if (!raw) return '';
    const escaped = raw
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'")
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/,/g, '\\,');
    const color = String(opts.color || '#FFFFFF').replace('#', '') || 'FFFFFF';
    const size = Math.max(10, Math.min(96, Number(opts.size || 30)));
    const x = String(opts.x || '(w-text_w)/2');
    const y = String(opts.y || '(h*0.78)');
    return `drawtext=text='${escaped}':fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}${this.drawtextBoxSuffix('soft')}`;
  }

  private buildDrawtextLayers(
    items:
      | Array<{
          text?: string;
          color?: string;
          size?: number;
          x?: string;
          y?: string;
          startSec?: number;
          endSec?: number;
          shadowPreset?: string;
        }>
      | undefined,
  ): string[] {
    if (!Array.isArray(items) || items.length === 0) return [];
    return items
      .map((item) => {
        const text = String(item?.text || '').trim();
        if (!text) return '';
        const escaped = text
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'")
          .replace(/\[/g, '\\[')
          .replace(/\]/g, '\\]')
          .replace(/,/g, '\\,');
        const color = String(item?.color || '#FFFFFF').replace('#', '') || 'FFFFFF';
        const size = Math.max(10, Math.min(96, Number(item?.size || 30)));
        const x = String(item?.x || '(w-text_w)/2');
        const y = String(item?.y || '(h*0.78)');
        const start = Number(item?.startSec);
        const end = Number(item?.endSec);
        const enable =
          Number.isFinite(start) && Number.isFinite(end) && end > start
            ? `:enable='between(t,${Math.max(0, start).toFixed(3)},${Math.max(0, end).toFixed(3)})'`
            : '';
        const box = this.drawtextBoxSuffix(item?.shadowPreset);
        return `drawtext=text='${escaped}':fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}${box}${enable}`;
      })
      .filter(Boolean);
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      p.on('error', (e) =>
        reject(
          new Error(
            `ffmpeg spawn failed — install ffmpeg and ensure it is on PATH. ${e.message}`,
          ),
        ),
      );
      p.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-1200)}`));
      });
    });
  }
}
