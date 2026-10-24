import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  CheckSchema,
  CustomerNotificationSchema,
  FlightsQuery,
  OrderCreateSchema,
  OrderPatchSchema,
  PaginationQuery,
  PassengerSchema,
  PaymentSchema,
  ReminderCompleteSchema,
  ReminderCreateSchema,
  ReminderListQuery,
  ReminderPatchSchema,
  RuleUpdateSchema,
  SegmentPatchSchema,
  SegmentSchema,
  ServiceSchema,
  TicketSchema,
} from '@crm/contracts';
import { formatMoney, maskReference } from '@crm/domain';
import type { Core, UserActor } from '../core';
import { serializeOrder } from '../core/services/orders.service';
import { serializeSegment } from '../core/services/segments.service';
import { Actor, CORE, parse, send, UuidPipe as uuid, withIdempotency, type AuthedRequest } from './common';
import { serializeOffer } from './sales.controller';

@Controller('api/v1')
export class OperationsController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('orders')
  async orders(@Actor() actor: UserActor, @Query() q: unknown, @Res() res: Response) {
    const r = await this.core.orders.listOrders(actor, parse(PaginationQuery.strict(), q));
    send(res, 200, { ...r, items: r.items.map(serializeOrder) });
  }

  @Post('orders')
  async createOrder(@Actor() actor: UserActor, @Body() body: unknown, @Req() req: AuthedRequest, @Res() res: Response) {
    const input = parse(OrderCreateSchema, body);
    const r = await withIdempotency(this.core, actor, req, false, async () => ({ status: 201, body: serializeOrder(await this.core.orders.createOrder(actor, input)) }));
    send(res, r.status, r.body);
  }

  @Get('orders/:id')
  async order(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Res() res: Response) {
    const r = await this.core.orders.getOrder(actor, id);
    const full = r.canSeeFullReferences;
    send(res, 200, {
      ...r,
      order: {
        ...serializeOrder(r.order),
        segments: r.order.segments.map((s) => serializeSegment(s, full)),
        passengers: r.order.passengers.map((p) => ({ ...p, tickets: p.tickets.map((t) => ({ ...t, ticketNumber: full ? t.ticketNumber : maskReference(t.ticketNumber) })) })),
        payments: r.order.payments.map((p) => ({ ...p, amount: formatMoney({ amountMinor: p.amountMinor, currency: p.currency }), amountMinor: undefined })),
        services: r.order.services.map((s) => ({ ...s, amount: s.amountMinor !== null && s.currency ? formatMoney({ amountMinor: s.amountMinor, currency: s.currency }) : null, amountMinor: undefined })),
      },
    });
  }

  @Patch('orders/:id')
  async patchOrder(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    const { version, ...patch } = parse(OrderPatchSchema, body);
    send(res, 200, serializeOrder(await this.core.orders.updateOrder(actor, id, version, patch)));
  }

  @Post('orders/:id/payments')
  async payment(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Req() req: AuthedRequest, @Res() res: Response) {
    const input = parse(PaymentSchema, body);
    const r = await withIdempotency(this.core, actor, req, true, async () => {
      const out = await this.core.orders.recordPayment(actor, id, { ...input, receivedAt: new Date(input.receivedAt), businessKey: `idem:${actor.id}:${req.header('idempotency-key')}` });
      return { status: out.duplicate ? 200 : 201, body: { payment: { ...out.payment, amount: input.amount, amountMinor: undefined }, order: serializeOrder(out.order), paymentStateNote: out.paymentStateNote } };
    });
    send(res, r.status, r.body);
  }

  @Post('orders/:id/passengers')
  async passenger(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    const input = parse(PassengerSchema, body);
    send(res, 201, await this.core.orders.addPassenger(actor, id, { ...input, birthDate: input.birthDate ? new Date(input.birthDate) : null }));
  }

  @Post('orders/:id/services')
  async service(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, 201, await this.core.orders.addService(actor, id, parse(ServiceSchema, body)));
  }

  @Post('orders/:id/tickets')
  async ticket(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    const t = await this.core.orders.addTicket(actor, id, parse(TicketSchema, body));
    send(res, 201, { ...t, ticketNumber: maskReference(t.ticketNumber) });
  }

  @Post('orders/:id/segments')
  async segment(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, 201, serializeSegment(await this.core.segments.addSegment(actor, id, parse(SegmentSchema, body)), true));
  }

  @Patch('segments/:id')
  async patchSegment(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    const { version, ...patch } = parse(SegmentPatchSchema, body);
    send(res, 200, serializeSegment(await this.core.segments.updateSegment(actor, id, version, patch), true));
  }

  @Post('segments/:id/checks')
  async check(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    const input = parse(CheckSchema, body);
    if (input.action === 'start') send(res, 200, serializeSegment(await this.core.segments.startCheck(actor, id), true));
    else send(res, 201, await this.core.segments.saveCheck(actor, id, input));
  }

  @Post('segments/:id/customer-notifications')
  async customerNotification(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, 201, await this.core.segments.recordCustomerNotification(actor, id, parse(CustomerNotificationSchema, body)));
  }

  @Get('flights')
  async flights(@Actor() actor: UserActor, @Query() q: unknown, @Res() res: Response) {
    send(res, 200, await this.core.segments.flightsBoard(actor, parse(FlightsQuery, q)));
  }

  @Get('reminders')
  async reminders(@Actor() actor: UserActor, @Query() q: unknown, @Res() res: Response) {
    send(res, 200, await this.core.reminders.list(actor, parse(ReminderListQuery, q)));
  }

  @Post('reminders')
  async createReminder(@Actor() actor: UserActor, @Body() body: unknown, @Res() res: Response) {
    send(res, 201, await this.core.reminders.createManual(actor, parse(ReminderCreateSchema, body)));
  }

  @Patch('reminders/:id')
  async patchReminder(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    const input = parse(ReminderPatchSchema, body);
    send(res, 200, input.action === 'snooze' ? await this.core.reminders.snooze(actor, id, input.minutes) : await this.core.reminders.cancel(actor, id, input.reason));
  }

  @Post('reminders/:id/complete')
  async completeReminder(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, 200, await this.core.reminders.complete(actor, id, parse(ReminderCompleteSchema, body).note ?? null));
  }

  @Patch('reminder-rules/:milestone')
  async rule(@Actor() actor: UserActor, @Param('milestone') milestone: string, @Body() body: unknown, @Res() res: Response) {
    send(res, 200, await this.core.reminders.updateRule(actor, milestone, parse(RuleUpdateSchema, body)));
  }

  @Get('reminder-rules')
  async rules(@Actor() actor: UserActor, @Res() res: Response) {
    send(res, 200, { items: await this.core.deps.prisma.reminderRule.findMany({ where: { companyId: actor.companyId, current: true }, orderBy: { offsetSeconds: 'desc' } }) });
  }

  @Get('notifications')
  async notifications(@Actor() actor: UserActor, @Res() res: Response) {
    const items = await this.core.deps.prisma.notification.findMany({ where: { companyId: actor.companyId, userId: actor.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    send(res, 200, { items });
  }

  @Post('notifications/:id/read')
  async readNotification(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Res() res: Response) {
    await this.core.deps.prisma.notification.updateMany({ where: { id, companyId: actor.companyId, userId: actor.id, readAt: null }, data: { readAt: new Date() } });
    send(res, 200, { ok: true });
  }

  @Get('team')
  async team(@Actor() actor: UserActor, @Res() res: Response) {
    const items = await this.core.deps.prisma.user.findMany({ where: { companyId: actor.companyId, status: 'active' }, select: { id: true, fullName: true, role: true }, orderBy: { fullName: 'asc' } });
    send(res, 200, { items });
  }
}

export { serializeOffer };
