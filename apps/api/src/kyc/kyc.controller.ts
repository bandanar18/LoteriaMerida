/// <reference types="multer" />
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { KYC_MAX_FILE_BYTES } from '@loteria/domain';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length } from 'class-validator';
import type { Response } from 'express';
import { AuthUser, ClientIp, CurrentUser, Roles } from '../identity/auth.guard';
import { KycService } from './kyc.service';

class SubmitKycDto {
  @Type(() => Number) @IsInt() @IsIn([2, 3]) targetLevel: number;
  @IsOptional() @IsString() @Length(0, 500) note?: string;
}

class ReviewKycDto {
  @IsIn(['APPROVE', 'REJECT']) decision: 'APPROVE' | 'REJECT';
  @IsOptional() @IsString() @Length(3, 300) reason?: string;
}

class KycQueryDto {
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED']) status?: string;
}

// multer en memoria con tope de tamaño y cantidad; el contenido se valida por firma en el servicio.
const uploads = AnyFilesInterceptor({ limits: { fileSize: KYC_MAX_FILE_BYTES, files: 5, fields: 5 } });

@Controller()
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Roles('PLAYER')
  @Get('me/kyc')
  status(@CurrentUser() u: AuthUser) {
    return this.kyc.status(u.id);
  }

  /** multipart/form-data: targetLevel, note y un archivo por tipo (el nombre del campo es el tipo: ID_FRONT, SELFIE…). */
  @Roles('PLAYER')
  @Post('me/kyc/requests')
  @UseInterceptors(uploads)
  submit(@CurrentUser() u: AuthUser, @Body() dto: SubmitKycDto, @UploadedFiles() files: Express.Multer.File[] = [], @ClientIp() ip: string) {
    return this.kyc.submit(
      u.id,
      dto.targetLevel,
      dto.note,
      files.map((f) => ({ type: f.fieldname, buffer: f.buffer, size: f.size })),
      ip,
    );
  }

  @Roles('COMPLIANCE', 'AUDITOR')
  @Get('admin/kyc/requests')
  list(@Query() q: KycQueryDto) {
    return this.kyc.listRequests(q.status);
  }

  @Roles('COMPLIANCE')
  @HttpCode(200)
  @Post('admin/kyc/requests/:id/review')
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewKycDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.kyc.review(id, dto.decision, dto.reason, { id: u.id, ip });
  }

  @Roles('COMPLIANCE', 'AUDITOR')
  @Get('admin/kyc/documents/:id/file')
  async file(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string, @Res() res: Response) {
    const { mime, content } = await this.kyc.document(id, { id: u.id, ip });
    res.set({
      'content-type': mime,
      'cache-control': 'no-store',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    res.send(content);
  }
}
