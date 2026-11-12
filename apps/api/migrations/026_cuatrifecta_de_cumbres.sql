-- MER-08 «Cuatrifecta de Cumbres»: noveno juego de lotería, números 0000–9999 (tablero nuevo DIGITS4).
-- Cuatrifecta exacta (EXACT) activa. Terminal 4 cifras (SUPER) y Aproximación (APPROX) quedan pendientes (manual, Anexo B.1 y B.2).
ALTER TABLE lottery.game DROP CONSTRAINT game_board_check;
ALTER TABLE lottery.game ADD CONSTRAINT game_board_check CHECK (board IN ('SYMBOLS', 'DIGITS3', 'KINO', 'DIGITS2', 'COLOR', 'DIGITS4'));
