import { ShortsService } from './shorts.service';
import { ShortsTranscodeService } from './shorts-transcode.service';
import { HttpService } from '@nestjs/axios';
import { CompleteShortUploadDto, CreateShortDto } from './dto/shorts.dto';

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

describe('failed music export never publishes an unedited source', () => {
  const previousRaw = process.env.SHORTS_UPLOAD_RAW_ON_FFMPEG_FAIL;
  const previousDisabled = process.env.SHORTS_DISABLE_FFMPEG;
  afterEach(() => {
    if (previousRaw === undefined)
      delete process.env.SHORTS_UPLOAD_RAW_ON_FFMPEG_FAIL;
    else process.env.SHORTS_UPLOAD_RAW_ON_FFMPEG_FAIL = previousRaw;
    if (previousDisabled === undefined)
      delete process.env.SHORTS_DISABLE_FFMPEG;
    else process.env.SHORTS_DISABLE_FFMPEG = previousDisabled;
  });

  function setup() {
    const storage = {
      downloadToFile: jest.fn().mockResolvedValue(undefined),
      uploadFileFromPath: jest.fn(),
      uploadBuffer: jest.fn(),
    };
    const transcode = {
      shouldProcess: jest.fn().mockReturnValue(true),
      processFile: jest
        .fn()
        .mockRejectedValue(new Error('Music download failed')),
      process: jest.fn().mockRejectedValue(new Error('Music download failed')),
      applyWatermark: jest.fn(),
    };
    const service: ShortsService = Object.assign(
      Object.create(ShortsService.prototype),
      {
        r2Storage: storage,
        shortsTranscode: transcode,
        subscriptionService: {
          checkCanUploadShort: jest.fn().mockResolvedValue({ allowed: true }),
        },
        prepareWatermarkOption: jest.fn().mockResolvedValue(true),
        logger: { error: jest.fn(), warn: jest.fn() },
      },
    );
    return { service, storage, transcode };
  }

  it('rejects presigned completion instead of watermarking and publishing the raw source', async () => {
    const { service, storage, transcode } = setup();
    await expect(
      service.completePresignedUpload({
        userId: 'user',
        videoKey: 'shorts/source.mp4',
        soundUrl: 'https://example.com/music.mp3',
      } as CompleteShortUploadDto),
    ).rejects.toThrow('Your edits were not published');
    expect(transcode.applyWatermark).not.toHaveBeenCalled();
    expect(storage.uploadFileFromPath).not.toHaveBeenCalled();
  });

  it('rejects multipart export even when the legacy raw fallback is enabled', async () => {
    process.env.SHORTS_UPLOAD_RAW_ON_FFMPEG_FAIL = '1';
    const { service, storage } = setup();
    await expect(
      service.uploadShort(
        {
          originalname: 'clip.mp4',
          mimetype: 'video/mp4',
          buffer: Buffer.from('fixture'),
        } as Express.Multer.File,
        null,
        {
          userId: 'user',
          soundUrl: 'https://example.com/music.mp3',
        } as CreateShortDto,
      ),
    ).rejects.toThrow('Video processing failed');
    expect(storage.uploadFileFromPath).not.toHaveBeenCalled();
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it('does not silently skip selected music when FFmpeg is disabled', () => {
    process.env.SHORTS_DISABLE_FFMPEG = '1';
    const service = new ShortsTranscodeService({} as HttpService);
    expect(() =>
      service.shouldProcess({
        soundUrl: 'https://example.com/music.mp3',
      } as CreateShortDto),
    ).toThrow('Music export is temporarily unavailable');
  });
});
