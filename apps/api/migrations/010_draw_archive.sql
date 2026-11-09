-- Reseteo del historial de sorteos desde el backoffice.
-- No borra nada: tickets, ledger (inmutable), RNG, actas y auditoría quedan intactos y los saldos no cambian.
-- Un sorteo archivado deja de contar en Mercado, terna, banda, frecuencias, riesgo y resultados públicos.
-- Se puede restaurar el mismo rango.
ALTER TABLE lottery.draw
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by uuid REFERENCES identity.app_user (id),
  ADD CONSTRAINT draw_archive_final CHECK (archived_at IS NULL OR status IN ('SETTLED', 'CANCELLED'));
CREATE INDEX draw_archived_idx ON lottery.draw (game_id, draw_at) WHERE archived_at IS NOT NULL;
