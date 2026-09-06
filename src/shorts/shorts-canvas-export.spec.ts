import { HttpService } from '@nestjs/axios';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ShortsTranscodeService } from './shorts-transcode.service';

const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
const available = [ffmpeg, ffprobe].every(
  (bin) => spawnSync(bin, ['-version']).status === 0,
);
const integration = available ? describe : describe.skip;

integration('canvas fill/fit export (real FFmpeg)', () => {
  let folder: string;
  let portrait: string;
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

  function probeSize(file: string) {
    const raw = run(ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      file,
    ])
      .toString()
      .trim();
    const [w, h] = raw.split(',').map(Number);
    return { w, h };
  }

  function cornerRgb(file: string) {
    const buf = run(ffmpeg, [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      'crop=2:2:0:0',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ]);
    return { r: buf[0], g: buf[1], b: buf[2] };
  }

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'eatix-canvas-test-'));
    portrait = join(folder, 'portrait.mp4');
    run(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=80x160:r=30:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      portrait,
    ]);
  });
  afterAll(() => {
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  it('fill 1:1 actually exports a square', async () => {
    const out = join(folder, 'fill.mp4');
    await service['extractClipSegment'](
      portrait,
      out,
      { trimStartSec: 0, trimEndSec: 1 },
      false,
      { w: 160, h: 160, fit: 'fill', backgroundHex: '#000000' },
    );
    expect(probeSize(out)).toEqual({ w: 160, h: 160 });
    const rgb = cornerRgb(out);
    expect(rgb.b).toBeGreaterThan(rgb.r + 40);
  });

  it('fit 1:1 pads with the chosen background', async () => {
    const out = join(folder, 'fit.mp4');
    await service['extractClipSegment'](
      portrait,
      out,
      { trimStartSec: 0, trimEndSec: 1 },
      false,
      { w: 160, h: 160, fit: 'fit', backgroundHex: '#F6A421' },
    );
    expect(probeSize(out)).toEqual({ w: 160, h: 160 });
    const rgb = cornerRgb(out);
    expect(rgb.r).toBeGreaterThan(180);
    expect(rgb.g).toBeGreaterThan(100);
    expect(rgb.g).toBeLessThan(200);
  });
});
