-- Programa de Agencias Virtuales — Fase 1: agencias, códigos, referidos y comisiones.
-- Diseño: WalletLoteria/DOCUMENTO_MAESTRO_WALLET.md (§4, §7, §8).
-- Las cuentas contables de la agencia son del mismo usuario (owner_type = 'PLAYER', owner_id = user_id),
-- con tipos propios AGENT_*: heredan el CHECK de saldo ≥ 0 y no se mezclan con el saldo de juego.

CREATE SCHEMA IF NOT EXISTS affiliate;

CREATE TABLE affiliate.agent (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL UNIQUE REFERENCES identity.app_user (id),
  display_name      text NOT NULL CHECK (length(display_name) BETWEEN 3 AND 40),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  terms_version     text NOT NULL,
  terms_accepted_at timestamptz NOT NULL,
  suspended_reason  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE affiliate.code (
  code       text PRIMARY KEY CHECK (code ~ '^FB[0-9A-HJKMNP-TV-Z]{6}$'),
  agent_id   uuid NOT NULL REFERENCES affiliate.agent (id),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CHECK (active = (retired_at IS NULL))
);
CREATE UNIQUE INDEX code_one_active_uq ON affiliate.code (agent_id) WHERE active;

-- Vinculación jugador → agencia: una por jugador, permanente e inmutable.
CREATE TABLE affiliate.referral (
  player_id  uuid PRIMARY KEY REFERENCES identity.app_user (id),
  agent_id   uuid NOT NULL REFERENCES affiliate.agent (id),
  code       text NOT NULL REFERENCES affiliate.code (code),
  source     text NOT NULL DEFAULT 'SIGNUP' CHECK (source IN ('SIGNUP', 'SUPPORT')),
  created_by uuid REFERENCES identity.app_user (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_agent_idx ON affiliate.referral (agent_id, created_at DESC);
CREATE TRIGGER referral_immutable BEFORE UPDATE OR DELETE ON affiliate.referral
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

-- Tasas: append-only. Vigente = la más reciente con valid_from <= now(); la del juego gana a la del producto.
CREATE TABLE affiliate.rate (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product    text NOT NULL CHECK (product IN ('LOTTERY', 'SPORTS')),
  game_id    uuid REFERENCES lottery.game (id),
  rate_bps   integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 2000),
  reason     text,
  valid_from timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES identity.app_user (id), -- NULL = carga inicial del sistema
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_lookup_idx ON affiliate.rate (product, game_id, valid_from DESC);
CREATE TRIGGER rate_immutable BEFORE UPDATE OR DELETE ON affiliate.rate
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

-- Topes anti-abuso por moneda (K10). NULL = sin tope.
CREATE TABLE affiliate.cap (
  currency     text PRIMARY KEY REFERENCES wallet.currency (code),
  max_per_play bigint CHECK (max_per_play >= 0),
  max_daily    bigint CHECK (max_daily >= 0)
);

CREATE TABLE affiliate.commission (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES affiliate.agent (id),
  player_id     uuid NOT NULL REFERENCES identity.app_user (id),
  product       text NOT NULL CHECK (product IN ('LOTTERY', 'SPORTS')),
  play_id       uuid UNIQUE REFERENCES lottery.play (id),
  ticket_id     uuid REFERENCES lottery.ticket (id),
  draw_id       uuid REFERENCES lottery.draw (id),
  game_id       uuid REFERENCES lottery.game (id),
  currency      text NOT NULL REFERENCES wallet.currency (code),
  base_amount   bigint NOT NULL CHECK (base_amount > 0),
  rate_bps      integer NOT NULL,
  amount        bigint NOT NULL CHECK (amount > 0),
  capped        boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RELEASED', 'REVERSED')),
  accrual_tx_id uuid NOT NULL REFERENCES wallet.ledger_transaction (id),
  final_tx_id   uuid REFERENCES wallet.ledger_transaction (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finalized_at  timestamptz,
  CHECK ((status = 'PENDING') = (final_tx_id IS NULL))
);
CREATE INDEX commission_agent_idx ON affiliate.commission (agent_id, created_at DESC);
CREATE INDEX commission_pending_draw_idx ON affiliate.commission (draw_id) WHERE status = 'PENDING';
CREATE INDEX commission_ticket_idx ON affiliate.commission (ticket_id);

-- Cuentas contables nuevas.
ALTER TABLE wallet.account DROP CONSTRAINT account_account_type_check;
ALTER TABLE wallet.account ADD CONSTRAINT account_account_type_check CHECK (account_type IN (
  'PLAYER_CASH', 'PLAYER_LOCKED', 'BETS_IN_PLAY', 'HOUSE_GGR', 'PAYMENT_CLEARING',
  'PLAYER_FUTURES', 'FUTURES_MARGIN', 'HOUSE_FUTURES_FEES', 'HOUSE_FUTURES_PNL',
  'HOUSE_PROMOTIONS',
  'AGENT_PENDING',      -- comisiones por liberar (de la agencia)
  'AGENT_CASH',         -- comisiones disponibles (de la agencia)
  'HOUSE_COMMISSIONS'   -- gasto de comisiones de la casa, por producto
));

-- Carga inicial: 3 % en lotería. Terminal Nevado (MER-04) en 0 % porque Terminal directo paga
-- 100× sobre 100 números (margen 0 %): con comisión la casa pierde (regla K11).
INSERT INTO affiliate.rate (product, game_id, rate_bps, reason)
VALUES ('LOTTERY', NULL, 300, 'Tasa inicial del programa: 3 %');
INSERT INTO affiliate.rate (product, game_id, rate_bps, reason)
SELECT 'LOTTERY', id, 0, 'K11: Terminal directo 100× sobre 100 números deja margen 0 %'
  FROM lottery.game WHERE code = 'MER-04';

INSERT INTO affiliate.cap (currency, max_per_play, max_daily) VALUES
  ('VES', 500000, NULL),       -- Bs 5.000,00 por jugada
  ('USDT', 50000000, NULL)     -- 50 USDT por jugada
ON CONFLICT DO NOTHING;
