// users.module.ts
import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AuditLogService } from 'src/audit/audit.service';
import { FaceLoginController } from '../face-login/face-login.controller';
import { FaceLoginService } from '../face-login/face-login.service';
import { FaceEngineService } from '../face-login/face-engine.service';

@Module({
  controllers: [UsersController, FaceLoginController],
  providers: [UsersService, PrismaService, AuditLogService, FaceLoginService, FaceEngineService],
})
export class UsersModule {}
