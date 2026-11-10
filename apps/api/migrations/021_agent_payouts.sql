-- Programa de Agencias Virtuales — Fase 3: retiros SOLO en bolívares por Pago Móvil.
-- Directorio de Pago Móvil (propios o de familiares), confirmación por SMS (simulada en DEMO),
-- tasa BCV cargada por el administrador y conversión USDT → Bs al retirar.
-- Diseño: WalletLoteria/DOCUMENTO_MAESTRO_WALLET.md (§4.5, §5, §8).

-- Catálogo de bancos con Pago Móvil (configurable desde el backoffice).
CREATE TABLE affiliate.bank (
  code   char(4) PRIMARY KEY CHECK (code ~ '^\d{4}$'),
  name   text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
INSERT INTO affiliate.bank (code, name) VALUES
  ('0102', 'Banco de Venezuela'), ('0104', 'Venezolano de Crédito'), ('0105', 'Mercantil'), ('0108', 'Provincial'),
  ('0114', 'Bancaribe'), ('0115', 'Exterior'), ('0128', 'Caroní'), ('0134', 'Banesco'), ('0137', 'Sofitasa'),
  ('0138', 'Plaza'), ('0151', 'BFC'), ('0156', '100% Banco'), ('0157', 'Delsur'), ('0163', 'Tesoro'),
  ('0166', 'Agrícola'), ('0168', 'Bancrecer'), ('0169', 'R4'), ('0171', 'Activo'), ('0172', 'Bancamiga'),
  ('0174', 'Banplus'), ('0175', 'Bicentenario'), ('0177', 'Banfanb'), ('0191', 'BNC');

-- Directorio de Pago Móvil de la agencia: propios (SELF) o de familiares (FAMILY).
CREATE TABLE affiliate.payout_account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES affiliate.agent (id),
  alias           text NOT NULL CHECK (length(alias) BETWEEN 1 AND 30),
  holder_kind     text NOT NULL CHECK (holder_kind IN ('SELF', 'FAMILY')),
  holder_name     text NOT NULL CHECK (length(holder_name) BETWEEN 3 AND 80),
  relationship    text CHECK (relationship IN ('PADRE_MADRE', 'HIJO', 'HERMANO', 'CONYUGE', 'ABUELO', 'NIETO', 'TIO', 'SOBRINO', 'PRIMO', 'SUEGRO', 'CUNADO')),
  bank_code       char(4) NOT NULL REFERENCES affiliate.bank (code),
  phone           text NOT NULL CHECK (phone ~ '^58(412|414|416|422|424|426)\d{7}$'),
  document_type   text NOT NULL CHECK (document_type IN ('V', 'E')),
  document_number text NOT NULL CHECK (document_number ~ '^\d{6,9}$'),
  is_default      boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INVALID')),
  invalid_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CHECK ((holder_kind = 'FAMILY') = (relationship IS NOT NULL))
);
CREATE UNIQUE INDEX payout_alias_uq   ON affiliate.payout_account (agent_id, lower(alias)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX payout_dest_uq    ON affiliate.payout_account (agent_id, bank_code, phone) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX payout_default_uq ON affiliate.payout_account (agent_id) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX payout_document_idx      ON affiliate.payout_account (document_type, document_number) WHERE deleted_at IS NULL;

-- Códigos de confirmación por SMS. Solo se guarda el hash del código; `payload` son los datos que se
-- guardarán al confirmar (el código vale solo para esos datos).
CREATE TABLE affiliate.sms_challenge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES identity.app_user (id),
  purpose     text NOT NULL CHECK (purpose IN ('PAYOUT_ACCOUNT_ADD', 'PAYOUT_ACCOUNT_EDIT')),
  target_id   uuid REFERENCES affiliate.payout_account (id),
  payload     jsonb NOT NULL,
  code_hash   text NOT NULL,
  phone       text NOT NULL,                   -- teléfono registrado de la agencia (destino del SMS)
  delivery    text NOT NULL CHECK (delivery IN ('SMS', 'DEMO_SCREEN')),
  attempts    smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_challenge_user_idx ON affiliate.sms_challenge (user_id, created_at DESC);

-- Tasa USDT → VES (BCV), cargada por un administrador. Append-only: la vigente del día es la más reciente.
CREATE TABLE affiliate.fx_rate (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_e4    bigint NOT NULL CHECK (rate_e4 > 0),   -- Bs por 1 USDT × 10⁴ (45,20 → 452000)
  source     text NOT NULL DEFAULT 'BCV',
  valid_date date NOT NULL,                         -- día (America/Caracas) en que aplica
  created_by uuid NOT NULL REFERENCES identity.app_user (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fx_rate_date_idx ON affiliate.fx_rate (valid_date DESC, created_at DESC);
CREATE TRIGGER fx_rate_immutable BEFORE UPDATE OR DELETE ON affiliate.fx_rate
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

-- Retiros de agencia: misma cola de caja que los de jugador.
ALTER TABLE payments.withdrawal
  ADD COLUMN source            text NOT NULL DEFAULT 'PLAYER' CHECK (source IN ('PLAYER', 'AGENT')),
  ADD COLUMN payout_account_id uuid REFERENCES affiliate.payout_account (id),
  ADD COLUMN source_currency   text REFERENCES wallet.currency (code),
  ADD COLUMN source_amount     bigint CHECK (source_amount > 0),
  ADD COLUMN fx_rate_id        uuid REFERENCES affiliate.fx_rate (id);
-- Un retiro de agencia SIEMPRE se paga en VES por Pago Móvil; si sale de USDT lleva la tasa congelada.
ALTER TABLE payments.withdrawal ADD CONSTRAINT withdrawal_agent_ves CHECK (
  source <> 'AGENT' OR (
    currency = 'VES' AND method = 'PAGO_MOVIL' AND payout_account_id IS NOT NULL
    AND source_currency IS NOT NULL AND source_amount IS NOT NULL
    AND (source_currency = 'VES') = (fx_rate_id IS NULL)
  ));
CREATE INDEX withdrawal_payout_idx ON payments.withdrawal (payout_account_id) WHERE status = 'REQUESTED';

ALTER TABLE wallet.account DROP CONSTRAINT account_account_type_check;
ALTER TABLE wallet.account ADD CONSTRAINT account_account_type_check CHECK (account_type IN (
  'PLAYER_CASH', 'PLAYER_LOCKED', 'BETS_IN_PLAY', 'HOUSE_GGR', 'PAYMENT_CLEARING',
  'PLAYER_FUTURES', 'FUTURES_MARGIN', 'HOUSE_FUTURES_FEES', 'HOUSE_FUTURES_PNL',
  'HOUSE_PROMOTIONS',
  'AGENT_PENDING', 'AGENT_CASH', 'HOUSE_COMMISSIONS',
  'AGENT_LOCKED',   -- retiros por Pago Móvil en trámite (siempre VES)
  'HOUSE_FX'        -- puente de conversión USDT → VES (una cuenta por moneda)
));
