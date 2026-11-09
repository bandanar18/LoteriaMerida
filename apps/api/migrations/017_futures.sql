-- MER-06 «Cumbre Futuros»: perpetuos lineales con margen en USDT (docs/Cumbre_Futuros_MER-06.md).
-- Cantidades y precios en numeric (el motor los maneja con escala 1e8); dinero en micro-USDT (bigint) como el resto del ledger.

CREATE SCHEMA IF NOT EXISTS futures;

-- Cuentas nuevas del ledger.
ALTER TABLE wallet.account DROP CONSTRAINT account_account_type_check;
ALTER TABLE wallet.account ADD CONSTRAINT account_account_type_check CHECK (account_type IN (
  'PLAYER_CASH', 'PLAYER_LOCKED', 'BETS_IN_PLAY', 'HOUSE_GGR', 'PAYMENT_CLEARING',
  'PLAYER_FUTURES',      -- billetera de futuros del jugador
  'FUTURES_MARGIN',      -- margen bloqueado en posiciones (del jugador)
  'HOUSE_FUTURES_FEES',  -- comisiones y tarifas de liquidación
  'HOUSE_FUTURES_PNL'    -- PnL y funding contra la casa (contraparte)
));

CREATE TABLE futures.contract (
  symbol             text PRIMARY KEY,
  base               text NOT NULL,
  name               text NOT NULL,
  qty_step           numeric(20, 8) NOT NULL,
  price_tick         numeric(20, 8) NOT NULL,
  min_notional       bigint NOT NULL,              -- micro-USDT
  max_leverage       integer NOT NULL CHECK (max_leverage BETWEEN 1 AND 125),
  default_leverage   integer NOT NULL,
  taker_ppm          integer NOT NULL,             -- 500 = 0,05 %
  maker_ppm          integer NOT NULL,
  liquidation_ppm    integer NOT NULL,
  max_net_exposure   bigint NOT NULL,              -- micro-USDT
  brackets           jsonb NOT NULL,               -- [{floor, cap, maxLeverage, mmrPpm, cum}] en micro-USDT
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSE_ONLY', 'PAUSED')),
  status_reason      text,
  sort               integer NOT NULL DEFAULT 0,
  CHECK (default_leverage BETWEEN 1 AND max_leverage)
);

-- Ajustes globales (uno solo).
CREATE TABLE futures.settings (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  house_capital           bigint NOT NULL,          -- micro-USDT asignado a futuros
  daily_loss_limit_ppm    integer NOT NULL,         -- 50000 = 5 %
  rules_version           text NOT NULL,
  is_demo                 boolean NOT NULL DEFAULT true
);

-- Cada precio usado queda guardado (fuentes, mediana) para poder reconstruir llenados, liquidaciones y funding.
CREATE TABLE futures.price_tick (
  id         bigserial PRIMARY KEY,
  symbol     text NOT NULL REFERENCES futures.contract (symbol),
  index_price numeric(20, 8) NOT NULL,
  sources    jsonb NOT NULL,                        -- {kraken: "74812.5", okx: …}
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_tick_symbol_idx ON futures.price_tick (symbol, created_at DESC);
CREATE TRIGGER price_tick_immutable BEFORE UPDATE OR DELETE ON futures.price_tick
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

-- Tasa de funding observada en el mercado (mediana de fuentes) y aplicada en cada periodo.
CREATE TABLE futures.funding_rate (
  id           bigserial PRIMARY KEY,
  symbol       text NOT NULL REFERENCES futures.contract (symbol),
  funding_time timestamptz NOT NULL,
  rate         numeric(12, 8) NOT NULL,
  mark_price   numeric(20, 8) NOT NULL,
  sources      jsonb NOT NULL,
  applied_at   timestamptz,
  UNIQUE (symbol, funding_time)
);

-- Aceptación del aviso de riesgo y límites personales (juego responsable).
CREATE TABLE futures.player_settings (
  player_id         uuid PRIMARY KEY REFERENCES identity.app_user (id),
  risk_accepted_at  timestamptz NOT NULL,
  max_leverage      integer CHECK (max_leverage BETWEEN 1 AND 125),
  daily_loss_limit  bigint CHECK (daily_loss_limit > 0),    -- micro-USDT
  daily_transfer_limit bigint CHECK (daily_transfer_limit > 0),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Preferencias por contrato: apalancamiento y modo de margen (como en el exchange).
CREATE TABLE futures.player_contract (
  player_id   uuid NOT NULL REFERENCES identity.app_user (id),
  symbol      text NOT NULL REFERENCES futures.contract (symbol),
  leverage    integer NOT NULL,
  margin_mode text NOT NULL CHECK (margin_mode IN ('ISOLATED', 'CROSS')),
  PRIMARY KEY (player_id, symbol)
);

CREATE TABLE futures.position (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     uuid NOT NULL REFERENCES identity.app_user (id),
  symbol        text NOT NULL REFERENCES futures.contract (symbol),
  side          text NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  qty           numeric(20, 8) NOT NULL CHECK (qty >= 0),
  entry_price   numeric(20, 8) NOT NULL,
  margin        bigint NOT NULL CHECK (margin >= 0),   -- micro-USDT bloqueado (aislado) o margen inicial (cruzado)
  leverage      integer NOT NULL,
  margin_mode   text NOT NULL CHECK (margin_mode IN ('ISOLATED', 'CROSS')),
  tp_price      numeric(20, 8),
  sl_price      numeric(20, 8),
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'LIQUIDATED')),
  realized_pnl  bigint NOT NULL DEFAULT 0,
  fees_paid     bigint NOT NULL DEFAULT 0,
  funding_paid  bigint NOT NULL DEFAULT 0,             -- + pagado, − cobrado
  rules_version text NOT NULL,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  close_price   numeric(20, 8),
  close_tick_id bigint REFERENCES futures.price_tick (id)
);
-- Modo unidireccional: una sola posición abierta por jugador y contrato.
CREATE UNIQUE INDEX position_open_uq ON futures.position (player_id, symbol) WHERE status = 'OPEN';
CREATE INDEX position_open_symbol_idx ON futures.position (symbol) WHERE status = 'OPEN';

CREATE TABLE futures.order (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id       uuid NOT NULL REFERENCES identity.app_user (id),
  symbol          text NOT NULL REFERENCES futures.contract (symbol),
  side            text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  type            text NOT NULL CHECK (type IN ('MARKET', 'LIMIT', 'STOP_MARKET', 'TAKE_PROFIT', 'STOP_LOSS', 'LIQUIDATION')),
  qty             numeric(20, 8) NOT NULL CHECK (qty > 0),
  price           numeric(20, 8),          -- límite
  stop_price      numeric(20, 8),          -- disparo
  time_in_force   text NOT NULL DEFAULT 'GTC' CHECK (time_in_force IN ('GTC', 'IOC', 'FOK')),
  reduce_only     boolean NOT NULL DEFAULT false,
  post_only       boolean NOT NULL DEFAULT false,
  leverage        integer NOT NULL,
  margin_mode     text NOT NULL CHECK (margin_mode IN ('ISOLATED', 'CROSS')),
  status          text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED')),
  reject_reason   text,
  idempotency_key text NOT NULL,
  rules_version   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, idempotency_key)
);
CREATE INDEX order_open_idx ON futures.order (symbol, status) WHERE status = 'NEW';
CREATE INDEX order_player_idx ON futures.order (player_id, created_at DESC);

CREATE TABLE futures.fill (
  id            bigserial PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES futures.order (id),
  position_id   uuid REFERENCES futures.position (id),
  player_id     uuid NOT NULL REFERENCES identity.app_user (id),
  symbol        text NOT NULL,
  side          text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty           numeric(20, 8) NOT NULL,
  price         numeric(20, 8) NOT NULL,
  notional      bigint NOT NULL,
  fee           bigint NOT NULL,
  liquidity     text NOT NULL CHECK (liquidity IN ('MAKER', 'TAKER')),
  realized_pnl  bigint NOT NULL DEFAULT 0,
  price_tick_id bigint REFERENCES futures.price_tick (id),
  ledger_tx_id  uuid REFERENCES wallet.ledger_transaction (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fill_player_idx ON futures.fill (player_id, created_at DESC);
CREATE INDEX fill_day_idx ON futures.fill (created_at);

CREATE TABLE futures.funding_payment (
  id           bigserial PRIMARY KEY,
  position_id  uuid NOT NULL REFERENCES futures.position (id),
  player_id    uuid NOT NULL REFERENCES identity.app_user (id),
  symbol       text NOT NULL,
  funding_time timestamptz NOT NULL,
  rate         numeric(12, 8) NOT NULL,
  notional     bigint NOT NULL,
  amount       bigint NOT NULL,              -- + pagó el jugador, − cobró
  ledger_tx_id uuid REFERENCES wallet.ledger_transaction (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (position_id, funding_time)
);

CREATE TABLE futures.liquidation (
  id             bigserial PRIMARY KEY,
  position_id    uuid NOT NULL REFERENCES futures.position (id),
  player_id      uuid NOT NULL REFERENCES identity.app_user (id),
  symbol         text NOT NULL,
  side           text NOT NULL,
  qty            numeric(20, 8) NOT NULL,
  entry_price    numeric(20, 8) NOT NULL,
  mark_price     numeric(20, 8) NOT NULL,
  margin         bigint NOT NULL,
  loss           bigint NOT NULL,            -- pérdida cobrada al margen
  fee            bigint NOT NULL,            -- tarifa de liquidación cobrada
  returned       bigint NOT NULL,            -- devuelto al jugador
  absorbed       bigint NOT NULL,            -- faltante absorbido por la casa (protección de saldo negativo)
  price_tick_id  bigint REFERENCES futures.price_tick (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Incidencias del feed o pausas manuales (como draw_incident).
CREATE TABLE futures.incident (
  id          bigserial PRIMARY KEY,
  symbol      text REFERENCES futures.contract (symbol),
  kind        text NOT NULL CHECK (kind IN ('FEED_DOWN', 'PRICE_JUMP', 'MANUAL_PAUSE', 'RESUMED', 'LOSS_LIMIT')),
  description text NOT NULL,
  created_by  uuid REFERENCES identity.app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Contratos (manual §2 y §6). Montos en micro-USDT.
INSERT INTO futures.contract (symbol, base, name, qty_step, price_tick, min_notional, max_leverage, default_leverage,
                              taker_ppm, maker_ppm, liquidation_ppm, max_net_exposure, brackets, sort) VALUES
  ('BTCUSDT', 'BTC', 'Bitcoin', 0.001, 0.1, 5000000, 50, 10, 500, 200, 5000, 250000000000,
   '[{"floor":0,"cap":10000000000,"maxLeverage":50,"mmrPpm":4000,"cum":0},
     {"floor":10000000000,"cap":50000000000,"maxLeverage":25,"mmrPpm":5000,"cum":10000000},
     {"floor":50000000000,"cap":100000000000,"maxLeverage":20,"mmrPpm":10000,"cum":260000000}]', 1),
  ('ETHUSDT', 'ETH', 'Ether', 0.001, 0.01, 5000000, 50, 10, 500, 200, 5000, 150000000000,
   '[{"floor":0,"cap":10000000000,"maxLeverage":50,"mmrPpm":5000,"cum":0},
     {"floor":10000000000,"cap":50000000000,"maxLeverage":25,"mmrPpm":6500,"cum":15000000},
     {"floor":50000000000,"cap":100000000000,"maxLeverage":20,"mmrPpm":10000,"cum":190000000}]', 2),
  ('SOLUSDT', 'SOL', 'Solana', 0.01, 0.001, 5000000, 25, 5, 500, 200, 5000, 75000000000,
   '[{"floor":0,"cap":5000000000,"maxLeverage":25,"mmrPpm":10000,"cum":0},
     {"floor":5000000000,"cap":25000000000,"maxLeverage":20,"mmrPpm":15000,"cum":25000000},
     {"floor":25000000000,"cap":50000000000,"maxLeverage":10,"mmrPpm":25000,"cum":275000000}]', 3);

INSERT INTO futures.settings (house_capital, daily_loss_limit_ppm, rules_version) VALUES (1000000000000, 50000, 'MER-06 v0.1-borrador');
