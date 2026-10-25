import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SupplierCreateSchema, SupplierImportSchema, SupplierListQuery, SupplierPatchSchema } from '@crm/contracts';
import type { Core, UserActor } from '../core';
import { Actor, CORE, parse, send, UuidPipe as uuid } from './common';

/** Turoperatorlar va xizmat yetkazib beruvchilar ma'lumotnomasi. Ro'yxat — barcha rollar (aloqa ma'lumotisiz); o'zgartirish — suppliers.manage. */
@Controller('api/v1/suppliers')
export class SuppliersController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get()
  async list(@Actor() actor: UserActor, @Query() q: unknown, @Res() res: Response) {
    send(res, 200, await this.core.suppliers.list(actor, parse(SupplierListQuery, q)));
  }

  /** Turoperatorlar ro'yxatini idempotent import qilish (dublikat yaratmaydi). */
  @Post('import-tour-operators')
  async importTourOperators(@Actor() actor: UserActor, @Body() body: unknown, @Res() res: Response) {
    send(res, 200, await this.core.suppliers.importTourOperators(actor, parse(SupplierImportSchema, body).names));
  }

  @Post()
  async create(@Actor() actor: UserActor, @Body() body: unknown, @Res() res: Response) {
    send(res, 201, await this.core.suppliers.create(actor, parse(SupplierCreateSchema, body)));
  }

  @Patch(':id')
  async update(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, 200, await this.core.suppliers.update(actor, id, parse(SupplierPatchSchema, body)));
  }
}
