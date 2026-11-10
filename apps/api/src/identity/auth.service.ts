import { grantSignupBonus } from './signup-bonus';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isAdult, isValidDocument, normalizeVePhone } from '@loteria/domain';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../common/db.service';
import { BusinessError, pgErrorCode } from '../common/errors';
import { localDate } from '../common/time';
import { config } from '../config';
import { AffiliateService } from '../affiliate/affiliate.service';
import { LedgerService } from '../wallet/ledger.service';
import { RegisterDto } from './auth.dto';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly affiliate: AffiliateService,
  ) {}

  async register(dto: RegisterDto, meta: SessionMeta) {
    if (!isAdult(dto.birthDate, localDate())) {
      throw new BusinessError('UNDERAGE', 'Debes ser mayor de 18 años para registrarte');
    }
    const docNumber = dto.documentNumber.replace(/[.\s-]/g, '').toUpperCase();
    if (!isValidDocument(dto.documentType, docNumber)) {
      throw new BusinessError('INVALID_INPUT', 'Número de documento inválido');
    }
    const phone = normalizeVePhone(dto.phone);
    if (!phone) throw new BusinessError('INVALID_INPUT', 'Teléfono venezolano inválido');

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    try {
      const user = await this.db.tx(async (c) => {
        const res = await c.query(
          `INSERT INTO identity.app_user
             (kind, role, email, phone, document_type, document_number, first_name, last_name, birth_date,
              state, city, password_hash, currency_default, demo_terms_accepted_at)
           VALUES ('PLAYER', 'PLAYER', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
           RETURNING id, role, kind`,
          [
            dto.email.trim().toLowerCase(),
            phone,
            dto.documentType,
            docNumber,
            dto.firstName.trim(),
            dto.lastName.trim(),
            dto.birthDate,
            dto.state ?? null,
            dto.city ?? null,
            passwordHash,
            dto.currency,
          ],
        );
        const u = res.rows[0];
        await this.ledger.playerCash(c, u.id, 'VES');
        await this.ledger.playerCash(c, u.id, 'USDT');
        // Bono de bienvenida DEMO (10.000 Bs y 10 USDT), en la misma transacción del registro.
        u.signup_bonus = await grantSignupBonus(c, this.ledger, this.audit, u.id);
        // Agencias Virtuales: vínculo permanente con la agencia del código (si es válido).
        u.referral = await this.affiliate.attachReferral(
          c,
          u.id,
          dto.referralCode,
          { documentType: dto.documentType, documentNumber: docNumber, phone },
          meta.ip,
        );
        await this.audit.log(c, {
          actorType: 'PLAYER',
          actorId: u.id,
          action: 'PLAYER_REGISTERED',
          entity: 'app_user',
          entityId: u.id,
          after: { email: dto.email.toLowerCase(), documentType: dto.documentType, currency: dto.currency },
          ip: meta.ip,
        });
        return u;
      });
      return { ...(await this.issueTokens(user, meta)), signupBonus: user.signup_bonus, referral: user.referral };
    } catch (err) {
      if (pgErrorCode(err) === '23505') {
        throw new BusinessError('CONFLICT', 'Ya existe una cuenta con ese correo, teléfono o documento');
      }
      throw err;
    }
  }

  async login(email: string, password: string, meta: SessionMeta) {
    const user = await this.db.one(
      `SELECT id, role, kind, status, password_hash FROM identity.app_user WHERE lower(email) = lower($1)`,
      [email.trim()],
    );
    // Verificar siempre algo para no filtrar existencia de cuentas por tiempo de respuesta.
    const ok = user ? await argon2.verify(user.password_hash, password) : await argon2.hash(password).then(() => false);
    if (!user || !ok) throw new BusinessError('INVALID_CREDENTIALS', 'Correo o contraseña incorrectos');
    if (user.status === 'BLOCKED') throw new BusinessError('ACCOUNT_BLOCKED', 'Cuenta bloqueada. Contacta a soporte.');
    await this.db.tx((c) =>
      this.audit.log(c, { actorType: user.kind, actorId: user.id, action: 'LOGIN', entity: 'app_user', entityId: user.id, ip: meta.ip }),
    );
    return this.issueTokens(user, meta);
  }

  /** Rotación de refresh token: el usado se revoca; reusar uno revocado revoca toda la familia. */
  async refresh(rawToken: string | undefined, meta: SessionMeta) {
    if (!rawToken) throw new BusinessError('INVALID_CREDENTIALS', 'Sesión expirada');
    const row = await this.db.one(
      `SELECT t.id, t.user_id, t.expires_at, t.revoked_at, u.role, u.kind, u.status
         FROM identity.refresh_token t JOIN identity.app_user u ON u.id = t.user_id
        WHERE t.token_hash = $1`,
      [sha256(rawToken)],
    );
    if (!row) throw new BusinessError('INVALID_CREDENTIALS', 'Sesión expirada');
    if (row.revoked_at) {
      await this.db.query(`UPDATE identity.refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
        row.user_id,
      ]);
      throw new BusinessError('INVALID_CREDENTIALS', 'Sesión revocada');
    }
    if (new Date(row.expires_at) < new Date() || row.status === 'BLOCKED') {
      throw new BusinessError('INVALID_CREDENTIALS', 'Sesión expirada');
    }
    const tokens = await this.issueTokens({ id: row.user_id, role: row.role, kind: row.kind }, meta);
    await this.db.query(
      `UPDATE identity.refresh_token SET revoked_at = now(),
              replaced_by = (SELECT id FROM identity.refresh_token WHERE token_hash = $2)
        WHERE id = $1`,
      [row.id, sha256(tokens.refreshToken)],
    );
    return tokens;
  }

  async logout(rawToken: string | undefined) {
    if (!rawToken) return;
    await this.db.query(`UPDATE identity.refresh_token SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
      sha256(rawToken),
    ]);
  }

  async me(userId: string) {
    const u = await this.db.one(
      `SELECT id, kind, role, email, phone, document_type, document_number, first_name, last_name, birth_date,
              state, city, status, self_excluded_until, kyc_level, currency_default, created_at
         FROM identity.app_user WHERE id = $1`,
      [userId],
    );
    if (!u) throw new BusinessError('NOT_FOUND', 'Usuario no encontrado');
    return u;
  }

  async selfExclude(userId: string, days: number, ip: string) {
    return this.db.tx(async (c) => {
      const res = await c.query(
        `UPDATE identity.app_user
            SET self_excluded_until = greatest(coalesce(self_excluded_until, now()), now() + make_interval(days => $2))
          WHERE id = $1 RETURNING self_excluded_until`,
        [userId, days],
      );
      await this.audit.log(c, {
        actorType: 'PLAYER',
        actorId: userId,
        action: 'SELF_EXCLUSION_STARTED',
        entity: 'app_user',
        entityId: userId,
        after: { days, until: res.rows[0].self_excluded_until },
        ip,
      });
      return { selfExcludedUntil: res.rows[0].self_excluded_until };
    });
  }

  private async issueTokens(user: { id: string; role: string; kind: string }, meta: SessionMeta) {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role, kind: user.kind },
      { expiresIn: config.accessTokenTtlSeconds },
    );
    const refreshToken = randomBytes(32).toString('base64url');
    await this.db.query(
      `INSERT INTO identity.refresh_token (user_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
      [user.id, sha256(refreshToken), config.refreshTokenTtlDays, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null],
    );
    return { accessToken, refreshToken, user: { id: user.id, role: user.role, kind: user.kind } };
  }
}
