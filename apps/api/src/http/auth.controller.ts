import { Body, Controller, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ActivateSchema, BlockUserSchema, ChangeRoleSchema, FinanceAccessSchema, InviteUserSchema, LoginSchema, MfaConfirmSchema } from '@crm/contracts';
import type { Core, UserActor } from '../core';
import { Actor, AllowWithoutMfa, CORE, CSRF_COOKIE, parse, Public, send, SESSION_COOKIE, type AuthedRequest } from './common';

@Controller('api/v1')
export class AuthController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  private cookieOpts() {
    return { secure: this.core.deps.config.cookieSecure, sameSite: 'lax' as const, path: '/' };
  }

  @Public()
  @Post('auth/login')
  async login(@Body() body: unknown, @Req() req: AuthedRequest, @Res() res: Response) {
    const input = parse(LoginSchema, body);
    const r = await this.core.auth.login({ ...input, ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null });
    res.cookie(SESSION_COOKIE, r.token, { ...this.cookieOpts(), httpOnly: true, maxAge: 7 * 24 * 3600_000 });
    res.cookie(CSRF_COOKIE, r.csrfToken, { ...this.cookieOpts(), httpOnly: false, maxAge: 7 * 24 * 3600_000 });
    send(res, 200, { ok: true, csrfToken: r.csrfToken });
  }

  @AllowWithoutMfa()
  @Post('auth/logout')
  async logout(@Actor() actor: UserActor, @Res() res: Response) {
    await this.core.auth.logout(actor);
    res.clearCookie(SESSION_COOKIE, this.cookieOpts());
    res.clearCookie(CSRF_COOKIE, this.cookieOpts());
    send(res, 200, { ok: true });
  }

  @Public()
  @Post('auth/activate')
  async activate(@Body() body: unknown, @Res() res: Response) {
    const input = parse(ActivateSchema, body);
    await this.core.auth.activate(input.token, input.password);
    send(res, 200, { ok: true });
  }

  @AllowWithoutMfa()
  @Post('auth/mfa/enroll')
  async enroll(@Actor() actor: UserActor, @Res() res: Response) {
    send(res, 200, await this.core.auth.startMfaEnrollment(actor));
  }

  @AllowWithoutMfa()
  @Post('auth/mfa/confirm')
  async confirm(@Actor() actor: UserActor, @Body() body: unknown, @Res() res: Response) {
    await this.core.auth.confirmMfaEnrollment(actor, parse(MfaConfirmSchema, body).code);
    send(res, 200, { ok: true });
  }

  @AllowWithoutMfa()
  @Get('me')
  async me(@Actor() actor: UserActor, @Req() req: AuthedRequest, @Res() res: Response) {
    send(res, 200, await this.core.auth.me(actor, req.session!));
  }

  @Get('users')
  async users(@Actor() actor: UserActor, @Res() res: Response) {
    send(res, 200, { items: await this.core.auth.listUsers(actor) });
  }

  @Post('users')
  async invite(@Actor() actor: UserActor, @Body() body: unknown, @Res() res: Response) {
    send(res, 201, await this.core.auth.inviteUser(actor, parse(InviteUserSchema, body)));
  }

  @Patch('users/:id/role')
  async role(@Actor() actor: UserActor, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    await this.core.auth.changeRole(actor, id, parse(ChangeRoleSchema, body).role);
    send(res, 200, { ok: true });
  }

  /** Menejerga tannarx va foydani ko'rish huquqini yoqish/o'chirish (faqat administrator). */
  @Patch('users/:id/finance-access')
  async financeAccess(@Actor() actor: UserActor, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, 200, await this.core.auth.setFinanceCostAccess(actor, id, parse(FinanceAccessSchema, body).enabled));
  }

  @Post('users/:id/block')
  async block(@Actor() actor: UserActor, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, 200, { moved: await this.core.auth.blockUser(actor, id, parse(BlockUserSchema, body).successorId) });
  }
}
