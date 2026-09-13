import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildClipVisualFilter } from './shorts-clip-visual';
import { ShortsTranscodeService } from './shorts-transcode.service';
import { HttpService } from '@nestjs/axios';

const bin = process.env.FFMPEG_BIN || 'ffmpeg';
const available = spawnSync(bin, ['-version']).status === 0;
const hasSubtitles = /\s(subtitles|ass)\s+V->V/.test(spawnSync(bin, ['-hide_banner', '-filters']).stdout?.toString() || '');
const integration = available ? describe : describe.skip;
function frame(filter: string) {
  const result = spawnSync(bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x80:d=0.1', '-vf', filter, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 20000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}
integration('per-clip visuals (actual FFmpeg pixels)', () => {
  it('keeps Fit padding and exports the selected background', () => {
    const out = frame(buildClipVisualFilter({ transform: { fit: 'fit' } }, { w: 80, h: 80, backgroundHex: '#0000FF' }));
    expect(out.length).toBe(80 * 80 * 3);
    expect(out[2]).toBeGreaterThan(200);
    const center = (40 * 80 + 40) * 3;
    expect(out[center]).toBeGreaterThan(200);
    expect(out[center + 2]).toBeLessThan(30);
  });
  it('fills the entire frame after rotation, zoom and flips', () => {
    const out = frame(buildClipVisualFilter({ transform: { rotation: 90, zoom: 1.8, x: 1, y: 0, flipX: true, flipY: true } }, { w: 80, h: 120 }));
    expect(out.length).toBe(80 * 120 * 3);
    expect(out[0]).toBeGreaterThan(200);
    expect(out[1]).toBeLessThan(30);
  });
  it('really desaturates pixels instead of applying a color overlay', () => {
    const out = frame(buildClipVisualFilter({ adjustments: { saturation: -1, contrast: 0.2, brightness: 0.1, sharpness: 0.3, vignette: 0.1 } }, { w: 80, h: 80 }));
    const center = (40 * 80 + 40) * 3;
    expect(Math.abs(out[center] - out[center + 1])).toBeLessThan(3);
    expect(Math.abs(out[center] - out[center + 2])).toBeLessThan(3);
  });
  (hasSubtitles ? it : it.skip)('renders offer card backgrounds with timed subtitle burn-in (requires libass)', () => {
    const service = new ShortsTranscodeService({} as HttpService);
    const folder = mkdtempSync(join(tmpdir(), 'editor-card-'));
    const file = join(folder, 'card.ass');
    try {
      const ass = service['buildAssFromOverlayItems']({ items: [{ text: 'Lunch\n£9', size: 24, backgroundColor: '#A74612', startSec: 0, endSec: 1, anchor: 'cc', xPct: 0.5, yPct: 0.5 }], width: 160, height: 80, durationSec: 1 });
      expect(ass).toContain('Card,,0,0,0');
      writeFileSync(file, ass);
      const out = frame(`ass=${file}`);
      const plain = frame('null');
      expect(out.equals(plain)).toBe(false);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
