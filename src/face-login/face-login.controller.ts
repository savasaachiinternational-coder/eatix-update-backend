import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Headers,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FaceLoginService } from './face-login.service';

@Controller('users/face-login')
export class FaceLoginController {
  constructor(private readonly faces: FaceLoginService) {}

  @Post('enroll')
  @UseGuards(JwtAuthGuard)
  enroll(@Req() req: any) {
    return this.faces.startEnrollment(req.user.id);
  }

  @Post('verify')
  verify(@Body() body: { deviceId: string; secret: string }) {
    return this.faces.startVerification(body.deviceId, body.secret);
  }

  @Post(':id/frame')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
      fileFilter: (_req, file, callback) => {
        if (!['image/jpeg', 'image/png'].includes(file.mimetype))
          return callback(
            new BadRequestException('A camera image is required'),
            false,
          );
        callback(null, true);
      },
    }),
  )
  frame(
    @Param('id') id: string,
    @Headers('x-face-session') key: string,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    return this.faces.frame(id, key, image?.buffer);
  }

  @Delete('attempt/:id')
  cancel(@Param('id') id: string, @Headers('x-face-session') key: string) {
    return this.faces.cancel(id, key);
  }

  @Delete('device/:id')
  @UseGuards(JwtAuthGuard)
  revoke(@Req() req: any, @Param('id') id: string) {
    return this.faces.revoke(req.user.id, id);
  }
}
