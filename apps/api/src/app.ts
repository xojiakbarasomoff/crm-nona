import 'reflect-metadata';
import { Module, type DynamicModule, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { Core } from './core';
import { AuthController } from './http/auth.controller';
import { AuthGuard, CORE, ErrorFilter, requestIdMiddleware } from './http/common';
import { OperationsController } from './http/operations.controller';
import { PlatformController } from './http/platform.controller';
import { SalesController } from './http/sales.controller';
import { FilesController } from './http/files.controller';
import { SuppliersController } from './http/suppliers.controller';
import { ALLOWED_MIME } from '@crm/integrations';

@Module({})
class AppModule {
  static register(core: Core): DynamicModule {
    return {
      module: AppModule,
      controllers: [AuthController, SalesController, OperationsController, PlatformController, FilesController, SuppliersController],
      providers: [{ provide: CORE, useValue: core }, { provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}

/** Builds the HTTP app around an existing core (used by main.ts and integration tests). */
export async function createApp(core: Core): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(core), { rawBody: true, logger: ['error', 'warn'], bodyParser: true });
  app.set('trust proxy', 'loopback');
  app.use(requestIdMiddleware);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '1mb' });
  app.useBodyParser('text', { type: 'text/*', limit: '1mb' });
  // Attachment uploads arrive as raw bytes; the service enforces the real size limit and type.
  app.useBodyParser('raw', { type: [...ALLOWED_MIME, 'application/octet-stream', 'application/zip', 'image/gif', 'application/x-msdownload'], limit: core.deps.config.maxUploadBytes * 2 });
  app.useGlobalFilters(new ErrorFilter((o, m) => core.deps.logger.error(o, m)));
  app.enableShutdownHooks();
  return app;
}
