-- Esquema inicial MVP (Doc. Maestro §17). Montos BIGINT en unidades mínimas; timestamps TIMESTAMPTZ (UTC).

CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS wallet;
CREATE SCHEMA IF NOT EXISTS lottery;
CREATE SCHEMA IF NOT EXISTS payments;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS rng;

-- ───────────────────────── Identidad ─────────────────────────
CREATE TABLE identity.app_user (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('PLAYER', 'STAFF')),
  role             text NOT NULL CHECK (role IN ('PLAYER', 'ADMIN', 'CASHIER', 'LOTTERY_OPERATOR', 'AUDITOR')),
  email            text NOT NULL,
  phone            text,
  document_type    text CHECK (document_type IN ('V', 'E', 'P')),
  document_number  text,
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  birth_date       date,
  state            text,
  city             text,
  password_hash    text NOT NULL,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED')),
  self_excluded_until timestamptz,
  kyc_level        smallint NOT NULL DEFAULT 1,
  currency_default text NOT NULL DEFAULT 'VES',
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'PLAYER' OR (role = 'PLAYER' AND document_number IS NOT NULL AND birth_date IS NOT NULL AND phone IS NOT NULL)),
  CHECK (kind <> 'STAFF' OR role <> 'PLAYER')
);
CREATE UNIQUE INDEX app_user_email_uq ON identity.app_user (lower(email));
CREATE UNIQUE INDEX app_user_phone_uq ON identity.app_user (phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX app_user_document_uq ON identity.app_user (document_type, document_number) WHERE document_number IS NOT NULL;

CREATE TABLE identity.refresh_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES identity.app_user (id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_token_user_idx ON identity.refresh_token (user_id);

-- ───────────────────────── Wallet / Ledger ─────────────────────────
CREATE TABLE wallet.currency (
  code       text PRIMARY KEY,
  minor_unit smallint NOT NULL,
  is_crypto  boolean NOT NULL
);

-- Convención de saldo: balance = Σ créditos − Σ débitos (para todas las cuentas).
-- Cuentas de jugador y pasivos de la casa (BETS_IN_PLAY) son de naturaleza acreedora → saldo positivo.
-- PAYMENT_CLEARING es un activo → su saldo se ve negativo (dinero recibido en el banco).
CREATE TABLE wallet.account (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type   text NOT NULL CHECK (owner_type IN ('PLAYER', 'HOUSE')),
  owner_id     uuid,
  account_type text NOT NULL CHECK (account_type IN ('PLAYER_CASH', 'PLAYER_LOCKED', 'BETS_IN_PLAY', 'HOUSE_GGR', 'PAYMENT_CLEARING')),
  product      text NOT NULL DEFAULT '',
  currency     text NOT NULL REFERENCES wallet.currency (code),
  balance      bigint NOT NULL DEFAULT 0,
  version      integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_type <> 'PLAYER' OR balance >= 0),
  CHECK ((owner_type = 'PLAYER') = (owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX account_uq ON wallet.account (owner_type, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'), account_type, product, currency);

CREATE TABLE wallet.ledger_transaction (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL,
  ref_product     text NOT NULL,
  ref_id          text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  metadata        jsonb,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_tx_ref_idx ON wallet.ledger_transaction (ref_product, ref_id);

CREATE TABLE wallet.ledger_entry (
  id             bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES wallet.ledger_transaction (id),
  account_id     uuid NOT NULL REFERENCES wallet.account (id),
  direction      char(1) NOT NULL CHECK (direction IN ('D', 'C')),
  amount         bigint NOT NULL CHECK (amount > 0),
  balance_after  bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entry_account_idx ON wallet.ledger_entry (account_id, id DESC);
CREATE INDEX ledger_entry_tx_idx ON wallet.ledger_entry (transaction_id);

-- Invariante de doble partida: por transacción Σ D = Σ C (verificado al COMMIT).
CREATE FUNCTION wallet.check_tx_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint; cur_count int;
BEGIN
  SELECT coalesce(sum(amount) FILTER (WHERE direction = 'D'), 0),
         coalesce(sum(amount) FILTER (WHERE direction = 'C'), 0)
    INTO d, c FROM wallet.ledger_entry WHERE transaction_id = NEW.transaction_id;
  IF d <> c THEN
    RAISE EXCEPTION 'Transacción % descuadrada: D=% C=%', NEW.transaction_id, d, c;
  END IF;
  SELECT count(DISTINCT a.currency) INTO cur_count
    FROM wallet.ledger_entry e JOIN wallet.account a ON a.id = e.account_id
   WHERE e.transaction_id = NEW.transaction_id;
  IF cur_count > 1 THEN
    RAISE EXCEPTION 'Transacción % mezcla monedas', NEW.transaction_id;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entry_balanced
  AFTER INSERT ON wallet.ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION wallet.check_tx_balanced();

-- Inmutabilidad: asientos, transacciones y auditoría son append-only.
CREATE FUNCTION public.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La tabla %.% es inmutable (append-only)', TG_TABLE_SCHEMA, TG_TABLE_NAME;
END $$;

CREATE TRIGGER ledger_entry_immutable BEFORE UPDATE OR DELETE ON wallet.ledger_entry
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
CREATE TRIGGER ledger_tx_immutable BEFORE UPDATE OR DELETE ON wallet.ledger_transaction
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

-- ───────────────────────── RNG ─────────────────────────
CREATE TABLE rng.rng_call (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer   text NOT NULL,
  ref_id     text NOT NULL,
  method     text NOT NULL,
  range_n    integer NOT NULL,
  result     integer NOT NULL,
  seed_hash  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER rng_call_immutable BEFORE UPDATE OR DELETE ON rng.rng_call
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

-- ───────────────────────── Lotería (Animalitos) ─────────────────────────
CREATE TABLE lottery.game (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  result_source        text NOT NULL CHECK (result_source IN ('OFFICIAL_FEED', 'INTERNAL_RNG', 'MANUAL')),
  payout_multiplier    numeric(6, 2) NOT NULL,
  close_minutes_before integer NOT NULL DEFAULT 5,
  cancel_window_minutes integer NOT NULL DEFAULT 5,
  timezone             text NOT NULL DEFAULT 'America/Caracas',
  license_ref          text,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE TABLE lottery.game_limit (
  game_id                  uuid NOT NULL REFERENCES lottery.game (id),
  currency                 text NOT NULL REFERENCES wallet.currency (code),
  min_play                 bigint NOT NULL,
  max_play                 bigint NOT NULL,
  max_ticket               bigint NOT NULL,
  max_liability_per_symbol bigint NOT NULL,
  PRIMARY KEY (game_id, currency)
);

CREATE TABLE lottery.symbol (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES lottery.game (id),
  number  text NOT NULL,
  name    text NOT NULL,
  emoji   text,
  sort    integer NOT NULL,
  UNIQUE (game_id, number),
  UNIQUE (game_id, sort)
);

CREATE TABLE lottery.schedule (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id   uuid NOT NULL REFERENCES lottery.game (id),
  weekday   smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = domingo
  draw_time time NOT NULL,
  active    boolean NOT NULL DEFAULT true,
  UNIQUE (game_id, weekday, draw_time)
);

CREATE TABLE lottery.draw (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id            uuid NOT NULL REFERENCES lottery.game (id),
  draw_at            timestamptz NOT NULL,
  sales_open_at      timestamptz NOT NULL,
  close_at           timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'SCHEDULED'
                     CHECK (status IN ('SCHEDULED', 'OPEN', 'CLOSED', 'RESULT_PENDING', 'RESULT_CONFIRMED', 'SETTLED', 'CANCELLED')),
  is_extraordinary   boolean NOT NULL DEFAULT false,
  seed_hash          text NOT NULL,       -- compromiso publicado antes de la venta
  server_seed        text NOT NULL,       -- secreto hasta que hay resultado
  proposed_symbol_id uuid REFERENCES lottery.symbol (id),
  proposed_by        uuid REFERENCES identity.app_user (id),
  proposed_at        timestamptz,
  result_symbol_id   uuid REFERENCES lottery.symbol (id),
  result_evidence    text,
  confirmed_by       uuid REFERENCES identity.app_user (id),
  confirmed_at       timestamptz,
  settled_at         timestamptz,
  cancelled_reason   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, draw_at),
  CHECK (close_at <= draw_at)
);
CREATE INDEX draw_status_idx ON lottery.draw (status, close_at);

CREATE TABLE lottery.ticket (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  verify_code     text NOT NULL,
  player_id       uuid NOT NULL REFERENCES identity.app_user (id),
  game_id         uuid NOT NULL REFERENCES lottery.game (id),
  channel         text NOT NULL DEFAULT 'WEB' CHECK (channel IN ('WEB', 'POS')),
  currency        text NOT NULL REFERENCES wallet.currency (code),
  total           bigint NOT NULL CHECK (total > 0),
  potential_win   bigint NOT NULL,
  total_win       bigint NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'WON', 'LOST', 'VOID', 'CANCELLED')),
  idempotency_key text NOT NULL,
  sold_at         timestamptz NOT NULL DEFAULT now(),
  cancelled_at    timestamptz,
  cancel_reason   text,
  UNIQUE (player_id, idempotency_key)
);
CREATE INDEX ticket_player_idx ON lottery.ticket (player_id, sold_at DESC);

CREATE TABLE lottery.play (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     uuid NOT NULL REFERENCES lottery.ticket (id),
  draw_id       uuid NOT NULL REFERENCES lottery.draw (id),
  symbol_id     uuid NOT NULL REFERENCES lottery.symbol (id),
  amount        bigint NOT NULL CHECK (amount > 0),
  potential_win bigint NOT NULL,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'WON', 'LOST', 'VOID')),
  win           bigint NOT NULL DEFAULT 0,
  settled_at    timestamptz,
  UNIQUE (ticket_id, draw_id, symbol_id)
);
CREATE INDEX play_open_by_draw_idx ON lottery.play (draw_id) WHERE status = 'OPEN';

CREATE TABLE lottery.exposure (
  draw_id      uuid NOT NULL REFERENCES lottery.draw (id),
  symbol_id    uuid NOT NULL REFERENCES lottery.symbol (id),
  currency     text NOT NULL REFERENCES wallet.currency (code),
  total_amount bigint NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  PRIMARY KEY (draw_id, symbol_id, currency)
);

-- ───────────────────────── Pagos ─────────────────────────
CREATE TABLE payments.deposit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      uuid NOT NULL REFERENCES identity.app_user (id),
  method         text NOT NULL CHECK (method IN ('PAGO_MOVIL', 'TRANSFER', 'USDT')),
  currency       text NOT NULL REFERENCES wallet.currency (code),
  amount         bigint NOT NULL CHECK (amount > 0),
  bank           text NOT NULL,
  reference      text NOT NULL,
  payer_phone    text,
  payer_document text,
  status         text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by    uuid REFERENCES identity.app_user (id),
  reviewed_at    timestamptz,
  reject_reason  text,
  ledger_tx_id   uuid REFERENCES wallet.ledger_transaction (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (method, bank, reference) -- evita doble acreditación de la misma referencia bancaria
);
CREATE INDEX deposit_status_idx ON payments.deposit (status, created_at);

CREATE TABLE payments.withdrawal (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id            uuid NOT NULL REFERENCES identity.app_user (id),
  method               text NOT NULL CHECK (method IN ('PAGO_MOVIL', 'TRANSFER', 'USDT')),
  currency             text NOT NULL REFERENCES wallet.currency (code),
  amount               bigint NOT NULL CHECK (amount > 0),
  destination          jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'PAID', 'REJECTED')),
  reviewed_by          uuid REFERENCES identity.app_user (id),
  reviewed_at          timestamptz,
  reject_reason        text,
  paid_reference       text,
  request_ledger_tx_id uuid REFERENCES wallet.ledger_transaction (id),
  final_ledger_tx_id   uuid REFERENCES wallet.ledger_transaction (id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX withdrawal_status_idx ON payments.withdrawal (status, created_at);

-- ───────────────────────── Auditoría (hash encadenado) ─────────────────────────
CREATE TABLE audit.audit_log (
  id         bigserial PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('PLAYER', 'STAFF', 'SYSTEM')),
  actor_id   uuid,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  ip         text,
  at         timestamptz NOT NULL,
  prev_hash  text NOT NULL,
  hash       text NOT NULL UNIQUE
);
CREATE INDEX audit_entity_idx ON audit.audit_log (entity, entity_id);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
