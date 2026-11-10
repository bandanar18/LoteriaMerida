import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { config } from '../config';
import { AuthUser, ClientIp, CurrentUser, Public, Roles } from '../identity/auth.guard';
import { CreateDepositDto, CreateWithdrawalDto, PayWithdrawalDto, RejectDto, StatusQueryDto } from './payments.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Datos de cobro que se muestran al jugador. */
  @Public()
  @Get('methods')
  methods() {
    return [
      { code: 'PAGO_MOVIL', currency: 'VES', label: 'Pago Móvil', payTo: config.payment.pagoMovil },
      { code: 'TRANSFER', currency: 'VES', label: 'Transferencia bancaria', payTo: config.payment.pagoMovil },
      { code: 'USDT', currency: 'USDT', label: `USDT (${config.payment.usdt.network})`, payTo: config.payment.usdt },
    ];
  }

  @Roles('PLAYER')
  @Post('deposits')
  deposit(@CurrentUser() u: AuthUser, @Body() dto: CreateDepositDto, @ClientIp() ip: string) {
    return this.payments.createDeposit(u.id, dto, ip);
  }

  @Roles('PLAYER')
  @Get('deposits')
  deposits(@CurrentUser() u: AuthUser) {
    return this.payments.myDeposits(u.id);
  }

  @Roles('PLAYER')
  @Post('withdrawals')
  withdraw(@CurrentUser() u: AuthUser, @Body() dto: CreateWithdrawalDto, @ClientIp() ip: string) {
    return this.payments.createWithdrawal(u.id, dto, ip);
  }

  @Roles('PLAYER')
  @Get('withdrawals')
  withdrawals(@CurrentUser() u: AuthUser) {
    return this.payments.myWithdrawals(u.id);
  }
}

@Roles('CASHIER', 'AUDITOR')
@Controller('admin/payments')
export class PaymentsAdminController {
  constructor(
    private readonly db: DbService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('deposits')
  deposits(@Query() q: StatusQueryDto) {
    return this.db.query(
      `SELECT d.id, d.method, d.currency, d.amount::text, d.bank, d.reference, d.payer_phone, d.payer_document,
              d.status, d.reject_reason, d.created_at, d.reviewed_at,
              u.email, u.first_name || ' ' || u.last_name AS player_name, u.document_type || '-' || u.document_number AS player_document,
              r.email AS reviewed_by_email
         FROM payments.deposit d
         JOIN identity.app_user u ON u.id = d.player_id
         LEFT JOIN identity.app_user r ON r.id = d.reviewed_by
        WHERE ($1::text IS NULL OR d.status = $1)
        ORDER BY d.created_at DESC LIMIT 200`,
      [q.status ?? null],
    );
  }

  @Roles('CASHIER')
  @HttpCode(200)
  @Post('deposits/:id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.payments.approveDeposit(id, { id: u.id, ip });
  }

  @Roles('CASHIER')
  @HttpCode(200)
  @Post('deposits/:id/reject')
  rejectDeposit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.payments.rejectDeposit(id, dto.reason, { id: u.id, ip });
  }

  @Get('withdrawals')
  withdrawals(@Query() q: StatusQueryDto) {
    return this.db.query(
      `SELECT w.id, w.method, w.currency, w.amount::text, w.destination, w.status, w.reject_reason, w.paid_reference,
              w.created_at, w.reviewed_at, w.source, w.source_currency, w.source_amount::text, f.rate_e4::text AS fx_rate_e4,
              (SELECT a.display_name FROM affiliate.agent a WHERE a.user_id = w.player_id) AS agent_name,
              u.email, u.first_name || ' ' || u.last_name AS player_name, u.document_type || '-' || u.document_number AS player_document,
              r.email AS reviewed_by_email
         FROM payments.withdrawal w
         JOIN identity.app_user u ON u.id = w.player_id
         LEFT JOIN affiliate.fx_rate f ON f.id = w.fx_rate_id
         LEFT JOIN identity.app_user r ON r.id = w.reviewed_by
        WHERE ($1::text IS NULL OR w.status = $1)
        ORDER BY w.created_at DESC LIMIT 200`,
      [q.status ?? null],
    );
  }

  @Roles('CASHIER')
  @HttpCode(200)
  @Post('withdrawals/:id/pay')
  pay(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PayWithdrawalDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.payments.payWithdrawal(id, dto.paidReference, { id: u.id, ip });
  }

  @Roles('CASHIER')
  @HttpCode(200)
  @Post('withdrawals/:id/reject')
  rejectWithdrawal(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.payments.rejectWithdrawal(id, dto.reason, { id: u.id, ip }, dto.invalidPayout === true);
  }
}
