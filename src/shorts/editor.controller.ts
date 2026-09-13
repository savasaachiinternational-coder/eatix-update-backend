import { BadRequestException, Body, Controller, Get, Post, UploadedFile, UseGuards, UseInterceptors, ServiceUnavailableException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { multerShortsOptions } from '../../middleware/multer-shorts.config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { buildClipVisualFilter } from './shorts-clip-visual';

function object(value: unknown) {
  try { const result = typeof value === 'string' ? JSON.parse(value) : value; return result && typeof result === 'object' && !Array.isArray(result) ? result : {}; }
  catch { throw new BadRequestException('Invalid editor settings'); }
}
export function runEditorProcess(binary: string, args: string[], timeout = 30000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const data: Buffer[] = []; let size = 0, error = '', expired = false;
    const timer = setTimeout(() => { expired = true; process.kill('SIGKILL'); }, timeout);
    process.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 20 * 1024 * 1024) { expired = true; process.kill('SIGKILL'); } else data.push(chunk); });
    process.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4000); });
    process.on('error', () => { clearTimeout(timer); reject(new ServiceUnavailableException('Media processing is not available on this server.')); });
    process.on('close', code => { clearTimeout(timer); if (code !== 0 || expired) reject(new BadRequestException(expired ? 'Processing took too long. Try a shorter video.' : 'Could not process this media. Check the file and try again.')); else resolve(Buffer.concat(data)); });
  });
}

@UseGuards(JwtAuthGuard)
@Controller('shorts/editor')
export class EditorController {
  private running = 0;
  @Get('capabilities')
  capabilities() {
    return { transcription: Boolean(process.env.EDITOR_WHISPER_MODEL), languages: ['en', 'bn'], framePreview: true };
  }
  private async withFile<T>(file: Express.Multer.File, work: () => Promise<T>) {
    if (!file?.path) throw new BadRequestException('Select a media file.');
    try {
      if (this.running >= 2) throw new ServiceUnavailableException('The editor server is busy. Please retry shortly.');
      this.running++;
      try { return await work(); } finally { this.running--; }
    } finally { await fs.unlink(file.path).catch(() => {}); }
  }
  @Post('frame')
  @UseInterceptors(FileInterceptor('file', { ...multerShortsOptions, limits: { fileSize: 250 * 1024 * 1024 } }))
  frame(@UploadedFile() file: Express.Multer.File, @Body() body: Record<string, unknown>) {
    return this.withFile(file, async () => {
      const canvas = object(body.canvas);
      const ratio = Math.max(0.25, Math.min(4, Number(canvas.width) / Number(canvas.height) || 9 / 16));
      const w = Math.round((ratio > 1 ? 480 : 480 * ratio) / 2) * 2;
      const h = Math.round((ratio > 1 ? 480 / ratio : 480) / 2) * 2;
      const filter = buildClipVisualFilter({ transform: object(body.transform), adjustments: object(body.adjustments) }, { w, h, fit: canvas.fit, backgroundHex: canvas.background?.hex });
      const time = Math.max(0, Math.min(180, Number(body.time) || 0));
      const args = ['-v', 'error', ...(file.mimetype.startsWith('video/') ? ['-ss', String(time)] : []), '-i', file.path, '-vf', filter, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
      const image = await runEditorProcess(process.env.FFMPEG_BIN || 'ffmpeg', args);
      if (!image.length) throw new BadRequestException('There is no frame at this time.');
      return { image: `data:image/jpeg;base64,${image.toString('base64')}` };
    });
  }
  @Post('transcribe')
  @UseInterceptors(FileInterceptor('file', { ...multerShortsOptions, limits: { fileSize: 250 * 1024 * 1024 } }))
  transcribe(@UploadedFile() file: Express.Multer.File, @Body() body: Record<string, unknown>) {
    return this.withFile(file, async () => {
      if (!process.env.EDITOR_WHISPER_MODEL) throw new ServiceUnavailableException('Automatic captions are not configured. You can import SRT or add captions manually.');
      const language = String(body.language || 'en');
      if (!['en', 'bn'].includes(language)) throw new BadRequestException('Choose English or Bangla.');
      const duration = Number((await runEditorProcess(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file.path])).toString());
      if (!Number.isFinite(duration) || duration > 180) throw new BadRequestException('Automatic captions support source videos up to 3 minutes. Import a shorter video or use SRT.');
      const audioPath = `${file.path}.speech.wav`;
      try {
        await runEditorProcess(process.env.FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-y', '-i', file.path, '-t', '180', '-vn', '-ac', '1', '-ar', '16000', audioPath], 60000);
        const result = await runEditorProcess(process.env.EDITOR_PYTHON_BIN || 'python3', [path.join(process.cwd(), 'scripts', 'editor-transcribe.py'), audioPath, language], 480000);
        const parsed = JSON.parse(result.toString());
        if (!Array.isArray(parsed.cues)) throw new BadRequestException('Transcription did not return caption cues.');
        return { cues: parsed.cues.slice(0, 500), language };
      } finally { await fs.unlink(audioPath).catch(() => {}); }
    });
  }
}
