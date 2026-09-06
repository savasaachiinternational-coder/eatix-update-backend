import { HttpService } from '@nestjs/axios';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ShortsTranscodeService } from './shorts-transcode.service';
import { buildShortsVideoFilters } from './shorts-ffmpeg-presets';

// Integration tests use generated tones, never remote media or credentials.
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
const available = [ffmpeg, ffprobe].every(
  (bin) => spawnSync(bin, ['-version']).status === 0,
);
const integration = available ? describe : describe.skip;

integration('music export (real FFmpeg)', () => {
  let folder: string;
  let silent: string;
  let original: string;
  let music: string;
  const service = new ShortsTranscodeService({} as HttpService);

  function run(bin: string, args: string[]) {
    const result = spawnSync(bin, args, {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`${result.error || ''}\n${result.stderr?.toString()}`);
    return result.stdout;
  }

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'eatix-music-test-'));
    silent = join(folder, 'silent.mp4');
    original = join(folder, 'original.mp4');
    music = join(folder, 'music.wav');
    run(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x240:r=30:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      silent,
    ]);
    run(ffmpeg, [
      '-y',
      '-i',
      silent,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-af',
      "volume=0:enable='gte(t,1)'",
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      original,
    ]);
    run(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:duration=0.35',
      music,
    ]);
  });
  afterAll(() => {
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  function render(overrides: Record<string, unknown> = {}) {
    const outPath = join(folder, `out-${Math.random()}.mp4`);
    const speed = Number(overrides.speed ?? 1);
    const args = service['composeFfmpegArgs']({
      inPath: silent,
      outPath,
      soundPath: music,
      vf: buildShortsVideoFilters({ speedFactor: speed }),
      speed,
      hasAudio: false,
      ...overrides,
    });
    run(ffmpeg, args);
    return outPath;
  }

  function duration(file: string) {
    return Number(
      run(ffprobe, [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=nw=1:nk=1',
        file,
      ]).toString(),
    );
  }

  function rms(file: string, start: number, length = 0.15) {
    const pcm = run(ffmpeg, [
      '-v',
      'error',
      '-ss',
      String(start),
      '-i',
      file,
      '-t',
      String(length),
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'f32le',
      'pipe:1',
    ]);
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 4) sum += pcm.readFloatLE(i) ** 2;
    return Math.sqrt(sum / (pcm.length / 4));
  }

  it.each([
    ['silent video, stream copy', {}, 2],
    ['silent video, gain adjustment', { musicVolume: 0.5 }, 2],
    ['original audio mixed with music', { hasAudio: true }, 2],
    ['trimmed video', { trimStartSec: 0.5, trimEndSec: 1.5 }, 1],
    ['double speed', { speed: 2 }, 1],
    ['half speed', { speed: 0.5 }, 4],
  ])('keeps music and the full duration: %s', (_label, changes, expected) => {
    const overrides = changes as Record<string, unknown>;
    const out = render({
      ...overrides,
      inPath: overrides.hasAudio ? original : silent,
    });
    expect(duration(out)).toBeCloseTo(Number(expected), 0);
    expect(rms(out, Number(expected) - 0.25)).toBeGreaterThan(0.025);
  });

  it('does not halve music gain when original audio is muted', () => {
    const out = render({ inPath: original, hasAudio: true, originalVolume: 0 });
    expect(rms(out, 0.1)).toBeGreaterThan(0.075);
    expect(rms(out, 0.1)).toBeLessThan(0.1);
  });

  it('changes original audio speed when music is selected', () => {
    const out = render({
      inPath: original,
      hasAudio: true,
      speed: 2,
      musicVolume: 0,
    });
    expect(duration(out)).toBeCloseTo(1, 0);
    expect(rms(out, 0.1)).toBeGreaterThan(0.05);
    expect(rms(out, 0.7)).toBeLessThan(0.005);
  });

  it('keeps photo timing and clip audio edits when joining three assets', async () => {
    const photo = join(folder, 'photo.png');
    run(ffmpeg, ['-y', '-i', silent, '-frames:v', '1', photo]);
    const merged = await service['buildTimelineFromClips'](
      [
        { path: original, mimetype: 'video/mp4' },
        { path: photo, mimetype: 'image/png' },
        { path: silent, mimetype: 'video/mp4' },
      ] as Express.Multer.File[],
      [
        { fileIndex: 0, trimEndSec: 2, speedFactor: 2, volume: 0 },
        { fileIndex: 1, type: 'photo', trimEndSec: 2, speedFactor: 2 },
        { fileIndex: 2, trimEndSec: 2 },
      ],
      `test-${Date.now()}`,
    );
    try {
      expect(duration(merged)).toBeCloseTo(4, 0);
      expect(rms(merged, 0.1)).toBeLessThan(0.005);
      const out = render({ inPath: merged, hasAudio: true });
      expect(duration(out)).toBeCloseTo(4, 0);
      for (const time of [0.2, 1.2, 3.7])
        expect(rms(out, time)).toBeGreaterThan(0.05);
    } finally {
      rmSync(merged, { force: true });
    }
  }, 30_000);
});
