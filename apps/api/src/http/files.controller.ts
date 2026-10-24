import { Controller, Delete, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { Core, UserActor } from '../core';
import { ATTACHMENT_OWNER_TYPES } from '../core/services/attachments.service';
import { Actor, CORE, parse, send, UuidPipe as uuid, type AuthedRequest } from './common';

const OwnerQuery = z.object({ ownerType: z.enum(ATTACHMENT_OWNER_TYPES), ownerId: z.string().uuid() }).strict();
const ContentQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(100) }).strict();

@Controller('api/v1/attachments')
export class FilesController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  /** Raw body upload: Content-Type = file MIME, X-File-Name = URL-encoded name. */
  @Post()
  async upload(@Actor() actor: UserActor, @Query() q: unknown, @Req() req: AuthedRequest, @Res() res: Response) {
    const owner = parse(OwnerQuery, q);
    const data = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
    let fileName = 'fayl';
    try {
      fileName = decodeURIComponent(req.header('x-file-name') ?? 'fayl');
    } catch {
      /* keep default */
    }
    send(res, 201, await this.core.attachments.upload(actor, { ...owner, fileName, declaredMime: req.header('content-type') ?? '', data }));
  }

  @Get()
  async list(@Actor() actor: UserActor, @Query() q: unknown, @Res() res: Response) {
    const owner = parse(OwnerQuery, q);
    send(res, 200, { items: await this.core.attachments.list(actor, owner.ownerType, owner.ownerId) });
  }

  @Post(':id/link')
  async link(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Res() res: Response) {
    send(res, 200, await this.core.attachments.downloadLink(actor, id));
  }

  @Get(':id/content')
  async content(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Query() q: unknown, @Res() res: Response) {
    const { exp, sig } = parse(ContentQuery, q);
    const file = await this.core.attachments.content(actor, id, exp, sig);
    res.status(200);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(file.data);
  }

  @Delete(':id')
  async remove(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Res() res: Response) {
    await this.core.attachments.remove(actor, id);
    send(res, 200, { ok: true });
  }
}
