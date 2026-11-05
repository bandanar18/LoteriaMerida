-- KYC por niveles (Doc. Maestro §6.2) y nuevos roles de staff (cumplimiento y trading deportivo).

ALTER TABLE identity.app_user DROP CONSTRAINT app_user_role_check;
ALTER TABLE identity.app_user ADD CONSTRAINT app_user_role_check
  CHECK (role IN ('PLAYER', 'ADMIN', 'CASHIER', 'LOTTERY_OPERATOR', 'AUDITOR', 'COMPLIANCE', 'SPORTS_TRADER'));
ALTER TABLE identity.app_user ADD CONSTRAINT app_user_kyc_level_check CHECK (kyc_level BETWEEN 0 AND 3);

-- Límites diarios por nivel y moneda (día calendario America/Caracas). 0 = operación no permitida.
-- Umbrales de demostración: los definitivos los fija el oficial de cumplimiento.
CREATE TABLE identity.kyc_level_limit (
  level                smallint NOT NULL CHECK (level BETWEEN 0 AND 3),
  currency             text NOT NULL REFERENCES wallet.currency (code),
  max_deposit_daily    bigint NOT NULL CHECK (max_deposit_daily >= 0),
  max_withdrawal_daily bigint NOT NULL CHECK (max_withdrawal_daily >= 0),
  PRIMARY KEY (level, currency)
);

INSERT INTO wallet.currency (code, minor_unit, is_crypto) VALUES ('VES', 2, false), ('USDT', 6, true) ON CONFLICT DO NOTHING;
INSERT INTO identity.kyc_level_limit (level, currency, max_deposit_daily, max_withdrawal_daily) VALUES
  (0, 'VES', 0, 0),                    (0, 'USDT', 0, 0),
  (1, 'VES', 2000000, 0),              (1, 'USDT', 100000000, 0),          -- 20.000 Bs / 100 USDT, sin retiros
  (2, 'VES', 50000000, 25000000),      (2, 'USDT', 1000000000, 500000000), -- 500.000 / 250.000 Bs; 1.000 / 500 USDT
  (3, 'VES', 500000000, 250000000),    (3, 'USDT', 10000000000, 5000000000);

-- Solicitud de subida de nivel con sus documentos.
CREATE TABLE identity.kyc_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES identity.app_user (id),
  from_level    smallint NOT NULL,
  target_level  smallint NOT NULL CHECK (target_level IN (2, 3)),
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  note          text,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_by   uuid REFERENCES identity.app_user (id),
  reviewed_at   timestamptz,
  reject_reason text
);
CREATE UNIQUE INDEX kyc_request_one_pending ON identity.kyc_request (user_id) WHERE status = 'PENDING';
CREATE INDEX kyc_request_status_idx ON identity.kyc_request (status, submitted_at);

-- Documentos cifrados en reposo (AES-256-GCM). El archivo vive fuera de la BD; aquí solo metadatos.
CREATE TABLE identity.kyc_document (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES identity.kyc_request (id),
  user_id     uuid NOT NULL REFERENCES identity.app_user (id),
  type        text NOT NULL CHECK (type IN ('ID_FRONT', 'ID_BACK', 'SELFIE', 'PROOF_OF_ADDRESS', 'SOURCE_OF_FUNDS')),
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes  integer NOT NULL CHECK (size_bytes > 0),
  sha256      text NOT NULL,           -- del archivo en claro, se verifica al descifrar
  storage_key text NOT NULL UNIQUE,
  enc_iv      text NOT NULL,
  enc_tag     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, type)
);
CREATE INDEX kyc_document_user_idx ON identity.kyc_document (user_id);
