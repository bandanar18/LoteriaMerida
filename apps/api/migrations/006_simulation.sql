-- Modo simulación (solo juegos demo y solo si SIMULATION_MODE está activo):
-- cada jugador tiene su propio sorteo privado que él mismo ejecuta con el RNG provably fair del sistema.
-- Se separa de los sorteos reales para que no aparezca en listados públicos, backoffice ni reportes.

ALTER TABLE lottery.draw ADD COLUMN sim_player_id uuid REFERENCES identity.app_user (id);
CREATE INDEX draw_sim_player_idx ON lottery.draw (sim_player_id, game_id, status) WHERE sim_player_id IS NOT NULL;
-- Un solo sorteo de simulación abierto por jugador y juego.
CREATE UNIQUE INDEX draw_sim_open_uq ON lottery.draw (sim_player_id, game_id) WHERE sim_player_id IS NOT NULL AND status = 'OPEN';

ALTER TABLE lottery.ticket ADD COLUMN is_simulation boolean NOT NULL DEFAULT false;
