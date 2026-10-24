import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  AssigneeSchema,
  DashboardQuery,
  DuplicateResolveSchema,
  LeadDetailsSchema,
  LeadListQuery,
  OfferSchema,
  OfferSentSchema,
  ReopenSchema,
  StageChangeSchema,
} from '@crm/contracts';
import { formatMoney } from '@crm/domain';
import type { Core, UserActor } from '../core';
import { Actor, CORE, parse, send, toDate, UuidPipe as uuid, withIdempotency, type AuthedRequest } from './common';


export function serializeOffer<T extends { amountMinor: bigint; currency: string }>(o: T) {
  return { ...o, amount: formatMoney({ amountMinor: o.amountMinor, currency: o.currency }), amountMinor: undefined };
}

@Controller('api/v1')
export class SalesController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('dashboard')
  async dashboard(@Actor() actor: UserActor, @Query() q: unknown, @Res() res: Response) {
    send(res, 200, await this.core.dashboard.compute(actor, parse(DashboardQuery, q)));
  }

  @Get('exports/leads.csv')
  async exportCsv(@Actor() actor: UserActor, @Query() q: unknown, @Res() res: Response) {
    const csv = await this.core.dashboard.exportLeadsCsv(actor, parse(DashboardQuery, q));
    res.status(200).type('text/csv; charset=utf-8').setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(String.fromCharCode(0xfeff) + csv);
  }

  @Get('leads')
  async leads(@Actor() actor: UserActor, @Query() q: unknown, @Res() res: Response) {
    send(res, 200, await this.core.leads.list(actor, parse(LeadListQuery, q)));
  }

  @Get('leads/:id')
  async lead(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Res() res: Response) {
    const r = await this.core.leads.get(actor, id);
    send(res, 200, { ...r, offers: r.offers.map(serializeOffer) });
  }

  @Patch('leads/:id')
  async patchLead(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    const { version, offerPrepDueAt, nextContactAt, ...rest } = parse(LeadDetailsSchema, body);
    send(res, 200, await this.core.leads.updateDetails(actor, id, version, { ...rest, offerPrepDueAt: toDate(offerPrepDueAt), nextContactAt: toDate(nextContactAt) }));
  }

  /** 202: the change is applied after amoCRM confirms it (sync_state=pending meanwhile). */
  @Patch('leads/:id/stage')
  async stage(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    const input = parse(StageChangeSchema, body);
    send(res, 202, await this.core.leads.requestStageChange(actor, id, input.version, input.stage, { reason: input.reason ?? null }));
  }

  @Patch('leads/:id/assignee')
  async assignee(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    const input = parse(AssigneeSchema, body);
    send(res, 202, await this.core.leads.requestReassign(actor, id, input.userId, input.reason));
  }

  @Post('leads/:id/reopen')
  async reopen(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    const input = parse(ReopenSchema, body);
    send(res, 202, await this.core.leads.requestReopen(actor, id, input.reason, input.stage));
  }

  @Post('leads/:id/offers')
  async offer(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Req() req: AuthedRequest, @Res() res: Response) {
    const input = parse(OfferSchema, body);
    const r = await withIdempotency(this.core, actor, req, false, async () => ({ status: 201, body: serializeOffer(await this.core.orders.createOffer(actor, id, { ...input, validUntil: toDate(input.validUntil) ?? null })) }));
    send(res, r.status, r.body);
  }

  @Post('offers/:id/sent')
  async offerSent(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, 200, serializeOffer(await this.core.orders.markOfferSent(actor, id, parse(OfferSentSchema, body).channel)));
  }

  @Post('offers/:id/accept')
  async offerAccept(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Res() res: Response) {
    send(res, 200, serializeOffer(await this.core.orders.acceptOffer(actor, id)));
  }

  @Get('contacts/:id')
  async contact(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Res() res: Response) {
    send(res, 200, await this.core.admin.getContact(actor, id));
  }

  @Get('duplicates')
  async duplicates(@Actor() actor: UserActor, @Res() res: Response) {
    send(res, 200, { items: await this.core.admin.listDuplicates(actor) });
  }

  @Post('duplicates/:id/resolve')
  async resolve(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, 200, await this.core.admin.resolveDuplicate(actor, id, parse(DuplicateResolveSchema, body)));
  }
}
