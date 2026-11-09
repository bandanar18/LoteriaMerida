-- Configuración desde el backoffice: sorteo automático, montos y horarios.

-- Sorteo automático: el resultado lo pone el RNG provably fair a la hora del sorteo, aunque el juego sea de resultado manual.
ALTER TABLE lottery.draw ADD COLUMN auto_rng boolean NOT NULL DEFAULT false;
