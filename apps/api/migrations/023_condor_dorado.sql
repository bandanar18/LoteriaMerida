-- MER-09 «Cóndor Dorado»: sexto juego de lotería, número 00–99 × color (rojo, azul, verde, amarillo) = 400 resultados.
-- Modalidades: número + color (EXACT), solo número (NUMBER) y solo color (COLOR). Tablero nuevo: COLOR.
ALTER TABLE lottery.modality DROP CONSTRAINT modality_code_check;
ALTER TABLE lottery.modality ADD CONSTRAINT modality_code_check
  CHECK (code IN ('EXACT', 'COMBINADA', 'MULTIPLE', 'TERMINAL', 'LAST_DIGIT', 'FULL', 'KINO5', 'KINO6', 'KINO7', 'APPROX', 'SUPER', 'DUAL',
                  'NUMBER', 'COLOR'));
ALTER TABLE lottery.game DROP CONSTRAINT game_board_check;
ALTER TABLE lottery.game ADD CONSTRAINT game_board_check CHECK (board IN ('SYMBOLS', 'DIGITS3', 'KINO', 'DIGITS2', 'COLOR'));
