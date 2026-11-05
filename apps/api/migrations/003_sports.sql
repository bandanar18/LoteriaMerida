-- Sportsbook con trader manual (Doc. Maestro §7 y §17.3). Cuotas NUMERIC(10,4); montos BIGINT.
CREATE SCHEMA IF NOT EXISTS sports;

CREATE TABLE sports.sport (
  code text PRIMARY KEY CHECK (code IN ('FOOTBALL', 'BASEBALL')),
  name text NOT NULL
);

CREATE TABLE sports.competition (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_code text NOT NULL REFERENCES sports.sport (code),
  name       text NOT NULL,
  country    text,
  sort       integer NOT NULL DEFAULT 100,
  UNIQUE (sport_code, name)
);

CREATE TABLE sports.participant (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_code text NOT NULL REFERENCES sports.sport (code),
  name       text NOT NULL,
  UNIQUE (sport_code, name)
);

CREATE TABLE sports.event (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id    uuid NOT NULL REFERENCES sports.competition (id),
  home_id           uuid NOT NULL REFERENCES sports.participant (id),
  away_id           uuid NOT NULL REFERENCES sports.participant (id),
  starts_at         timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED', 'LIVE', 'FINISHED', 'CANCELLED')),
  home_score        integer CHECK (home_score >= 0),
  away_score        integer CHECK (away_score >= 0),
  -- Resultado final con 4 ojos: uno propone, otro confirma.
  result_status     text NOT NULL DEFAULT 'NONE' CHECK (result_status IN ('NONE', 'PROPOSED', 'CONFIRMED')),
  proposed_home     integer,
  proposed_away     integer,
  proposed_evidence text,
  proposed_by       uuid REFERENCES identity.app_user (id),
  proposed_at       timestamptz,
  confirmed_by      uuid REFERENCES identity.app_user (id),
  confirmed_at      timestamptz,
  cancelled_reason  text,
  created_by        uuid REFERENCES identity.app_user (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (home_id <> away_id)
);
CREATE INDEX event_status_idx ON sports.event (status, starts_at);

CREATE TABLE sports.market (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES sports.event (id),
  type_code  text NOT NULL,
  line       numeric(6, 2),
  status     text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SUSPENDED', 'CLOSED', 'SETTLED', 'VOIDED')),
  void_reason text,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX market_uq ON sports.market (event_id, type_code, coalesce(line, -9999));

CREATE TABLE sports.selection (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id uuid NOT NULL REFERENCES sports.market (id),
  code      text NOT NULL,
  name      text NOT NULL,
  odds      numeric(10, 4) NOT NULL CHECK (odds >= 1.01 AND odds <= 1000),
  sort      integer NOT NULL,
  result    text CHECK (result IN ('WIN', 'LOSE', 'VOID')),
  UNIQUE (market_id, code)
);

CREATE TABLE sports.odds_history (
  id           bigserial PRIMARY KEY,
  selection_id uuid NOT NULL REFERENCES sports.selection (id),
  odds         numeric(10, 4) NOT NULL,
  changed_by   uuid REFERENCES identity.app_user (id),
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX odds_history_sel_idx ON sports.odds_history (selection_id, id DESC);
CREATE TRIGGER odds_history_immutable BEFORE UPDATE OR DELETE ON sports.odds_history
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

CREATE TABLE sports.bet_limit (
  currency                text PRIMARY KEY REFERENCES wallet.currency (code),
  min_stake               bigint NOT NULL,
  max_stake               bigint NOT NULL,
  max_payout              bigint NOT NULL,      -- por cupón
  max_selection_liability bigint NOT NULL,      -- Σ pago potencial abierto por selección
  max_total_odds          numeric(12, 4) NOT NULL
);

CREATE TABLE sports.bet_slip (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  player_id        uuid NOT NULL REFERENCES identity.app_user (id),
  type             text NOT NULL CHECK (type IN ('SINGLE', 'PARLAY')),
  currency         text NOT NULL REFERENCES wallet.currency (code),
  stake            bigint NOT NULL CHECK (stake > 0),
  total_odds       numeric(12, 4) NOT NULL,
  potential_payout bigint NOT NULL,
  payout           bigint NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'WON', 'LOST', 'VOID')),
  odds_policy      text NOT NULL CHECK (odds_policy IN ('ACCEPT_ANY', 'ACCEPT_HIGHER', 'NONE')),
  live             boolean NOT NULL DEFAULT false,
  idempotency_key  text NOT NULL,
  placed_at        timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz,
  UNIQUE (player_id, idempotency_key)
);
CREATE INDEX bet_slip_player_idx ON sports.bet_slip (player_id, placed_at DESC);
CREATE INDEX bet_slip_open_idx ON sports.bet_slip (id) WHERE status = 'OPEN';

CREATE TABLE sports.bet_leg (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slip_id      uuid NOT NULL REFERENCES sports.bet_slip (id),
  selection_id uuid NOT NULL REFERENCES sports.selection (id),
  market_id    uuid NOT NULL REFERENCES sports.market (id),
  event_id     uuid NOT NULL REFERENCES sports.event (id),
  odds_taken   numeric(10, 4) NOT NULL,
  result       text CHECK (result IN ('WIN', 'LOSE', 'VOID')),
  settled_at   timestamptz,
  UNIQUE (slip_id, event_id)  -- sin bet builder: una selección por evento en cada cupón
);
CREATE INDEX bet_leg_selection_idx ON sports.bet_leg (selection_id);

CREATE TABLE sports.exposure (
  selection_id uuid NOT NULL REFERENCES sports.selection (id),
  currency     text NOT NULL REFERENCES wallet.currency (code),
  liability    bigint NOT NULL DEFAULT 0 CHECK (liability >= 0),
  stake        bigint NOT NULL DEFAULT 0 CHECK (stake >= 0),
  PRIMARY KEY (selection_id, currency)
);

INSERT INTO sports.sport (code, name) VALUES ('FOOTBALL', 'Fútbol'), ('BASEBALL', 'Béisbol');
INSERT INTO sports.bet_limit (currency, min_stake, max_stake, max_payout, max_selection_liability, max_total_odds) VALUES
  ('VES',  1000,   500000,     50000000,    200000000,   500),  -- 10 Bs – 5.000 Bs; pago máx. 500.000 Bs; pasivo 2.000.000 Bs
  ('USDT', 500000, 100000000,  10000000000, 40000000000, 500);  -- 0,50 – 100 USDT; pago máx. 10.000; pasivo 40.000
