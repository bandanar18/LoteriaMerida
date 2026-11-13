-- Conector de cuotas externas (The Odds API): identifica de dónde viene cada liga y evento para sincronizarlos sin duplicar.
ALTER TABLE sports.competition ADD COLUMN IF NOT EXISTS external_key text;
CREATE UNIQUE INDEX IF NOT EXISTS competition_external_uq ON sports.competition (external_key) WHERE external_key IS NOT NULL;

ALTER TABLE sports.event ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS event_external_uq ON sports.event (external_id) WHERE external_id IS NOT NULL;

-- Historial de sincronizaciones: sobrevive a reinicios y permite ver los créditos que quedan en el plan.
CREATE TABLE IF NOT EXISTS sports.feed_run (
  id                bigserial PRIMARY KEY,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  trigger           text NOT NULL CHECK (trigger IN ('AUTO', 'MANUAL')),
  leagues           integer NOT NULL DEFAULT 0,
  events            integer NOT NULL DEFAULT 0,
  markets           integer NOT NULL DEFAULT 0,
  odds_changed      integer NOT NULL DEFAULT 0,
  credits_used      integer,
  credits_remaining integer,
  error             text
);
CREATE INDEX IF NOT EXISTS feed_run_started_idx ON sports.feed_run (started_at DESC);
