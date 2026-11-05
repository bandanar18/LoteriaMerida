import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { BusinessError } from './common/errors';
import { config } from './config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', 'loopback');
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => {
        const messages = errors.flatMap((e) => collect(e));
        return new BusinessError('INVALID_INPUT', messages[0] ?? 'Datos inválidos', { errors: messages });
      },
    }),
  );
  app.enableShutdownHooks();
  await app.listen(config.port);
  Logger.log(`API escuchando en http://localhost:${config.port}/api/v1`, 'Bootstrap');
}

function collect(e: import('class-validator').ValidationError, path = ''): string[] {
  const here = path ? `${path}.${e.property}` : e.property;
  const own = Object.values(e.constraints ?? {}).map((m) => `${here}: ${m}`);
  return [...own, ...(e.children ?? []).flatMap((c) => collect(c, here))];
}

bootstrap();
