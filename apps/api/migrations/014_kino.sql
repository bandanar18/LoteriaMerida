-- MER-02 «Kino Teleférico»: cuarto juego. Se eligen 5, 6 o 7 números del 01 al 40 y se extraen 7.
ALTER TABLE lottery.modality DROP CONSTRAINT modality_code_check;
ALTER TABLE lottery.modality ADD CONSTRAINT modality_code_check
  CHECK (code IN ('EXACT', 'COMBINADA', 'MULTIPLE', 'TERMINAL', 'LAST_DIGIT', 'FULL', 'KINO5', 'KINO6', 'KINO7'));

ALTER TABLE lottery.game DROP CONSTRAINT game_board_check;
ALTER TABLE lottery.game ADD CONSTRAINT game_board_check CHECK (board IN ('SYMBOLS', 'DIGITS3', 'KINO'));
-- Cuántos números salen en cada sorteo (Kino: 7; los demás: 1).
ALTER TABLE lottery.game ADD COLUMN draw_count smallint NOT NULL DEFAULT 1 CHECK (draw_count BETWEEN 1 AND 20);

-- Jugada Kino: los números elegidos, ordenados. symbol_id apunta al menor para que listados y uniones sigan funcionando.
ALTER TABLE lottery.play ADD COLUMN selection smallint[];
ALTER TABLE lottery.play DROP CONSTRAINT play_ticket_draw_symbol_modality_key;
CREATE UNIQUE INDEX play_ticket_draw_selection_uq
  ON lottery.play (ticket_id, draw_id, symbol_id, modality_id, coalesce(selection, '{}'::smallint[]));
CREATE INDEX play_kino_selection_idx ON lottery.play (draw_id, modality_id, selection) WHERE selection IS NOT NULL;

-- Resultado Kino: los 7 números en orden de extracción. result_symbol_id / proposed_symbol_id quedan con la primera bola.
ALTER TABLE lottery.draw ADD COLUMN result_numbers smallint[], ADD COLUMN proposed_numbers smallint[];
