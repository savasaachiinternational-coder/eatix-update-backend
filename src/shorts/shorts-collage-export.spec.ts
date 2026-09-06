import { HttpService } from '@nestjs/axios';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ShortsTranscodeService } from './shorts-transcode.service';
import { getCollageLayout } from './shorts-collage';

const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
const available = [ffmpeg, ffprobe].every(
  (bin) => spawnSync(bin, ['-version']).status === 0,
);
const integration = available ? describe : describe.skip;

integration('collage and stickers export (real FFmpeg)', () => {
  let folder: string;
  let blue: string;
  let red: string;
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

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'eatix-collage-test-'));
    blue = join(folder, 'blue.mp4');
    red = join(folder, 'red.mp4');
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
      blue,
    ]);
    run(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=80x160:r=30:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      red,
    ]);
  });
  afterAll(() => {
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  it('xstack split-h-2 is square and side-by-side', async () => {
    const out = await service['buildCollageFromClips'](
      [
        { path: blue, mimetype: 'video/mp4' },
        { path: red, mimetype: 'video/mp4' },
      ] as Express.Multer.File[],
      [
        { fileIndex: 0, trimEndSec: 1 },
        { fileIndex: 1, trimEndSec: 1 },
      ],
      `c-${Date.now()}`,
      { w: 160, h: 160, fit: 'fill', backgroundHex: '#000000' },
      getCollageLayout('split-h-2')!,
    );
    try {
      expect(probeSize(out)).toEqual({ w: 160, h: 160 });
    } finally {
      rmSync(out, { force: true });
    }
  });

  it('overlays a catalog sticker without changing output size', async () => {
    const stamped = join(folder, 'sticker.mp4');
    await service['applyStickers'](
      blue,
      stamped,
      [
        {
          catalogId: 'yum',
          xPct: 0.82,
          yPct: 0.16,
          scale: 1,
          rotateDeg: 0,
          startSec: 0,
          endSec: 1,
        },
      ],
      { w: 80, h: 160, fit: 'fill', backgroundHex: '#000000' },
    );
    expect(probeSize(stamped)).toEqual({ w: 80, h: 160 });
  });
});
