import {
  buildCanvasVideoFilter,
  parseCanvasFit,
  parseCanvasQuality,
  resolveCanvasDims,
  resolveCanvasFromDto,
  shortsShouldTranscode,
} from './shorts-ffmpeg-presets';

describe('canvas presets', () => {
  it('uses even pixels for every quality and ratio', () => {
    for (const quality of ['720p', '1080p'] as const) {
      for (const ratio of ['9:16', '1:1', '4:5', '16:9'] as const) {
        const { w, h } = resolveCanvasDims(ratio, quality);
        expect(w % 2).toBe(0);
        expect(h % 2).toBe(0);
      }
    }
    expect(resolveCanvasDims('1:1', '720p')).toEqual({ w: 720, h: 720 });
    expect(resolveCanvasDims('16:9', '1080p')).toEqual({ w: 1920, h: 1080 });
  });

  it('ignores 9:16 quality pixels when the ratio is square', () => {
    const canvas = resolveCanvasFromDto({
      aspectRatio: '1:1',
      exportWidth: 1080,
      exportHeight: 1920,
    });
    expect(canvas).toMatchObject({
      w: 1080,
      h: 1080,
      fit: 'fill',
      backgroundHex: '#000000',
    });
  });

  it('honors explicit non-9:16 export pixels', () => {
    const canvas = resolveCanvasFromDto({
      aspectRatio: '1:1',
      exportWidth: 720,
      exportHeight: 720,
      canvasFit: 'fit',
      backgroundColor: '#F6A421',
    });
    expect(canvas).toMatchObject({
      w: 720,
      h: 720,
      fit: 'fit',
      backgroundHex: '#F6A421',
    });
  });

  it('maps legacy quality ids', () => {
    expect(parseCanvasQuality('720x1280')).toBe('720p');
    expect(parseCanvasFit('cover')).toBe('fill');
  });

  it('builds fill crop vs fit pad graphs', () => {
    const fill = buildCanvasVideoFilter({
      width: 1080,
      height: 1080,
      fit: 'fill',
    });
    expect(fill).toContain('force_original_aspect_ratio=increase');
    expect(fill).toContain('crop=1080:1080');
    const fit = buildCanvasVideoFilter({
      width: 1080,
      height: 1080,
      fit: 'fit',
      backgroundHex: '#F6A421',
    });
    expect(fit).toContain('force_original_aspect_ratio=decrease');
    expect(fit).toContain('0xF6A421');
  });

  it('forces transcode for fit or a non-black background', () => {
    expect(
      shortsShouldTranscode({ watermark: false, canvasFit: 'fit' }),
    ).toBe(true);
    expect(
      shortsShouldTranscode({
        watermark: false,
        backgroundColor: '#F6A421',
      }),
    ).toBe(true);
    expect(shortsShouldTranscode({ watermark: false })).toBe(false);
  });
});
