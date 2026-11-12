-- MER-07 «Dupleta de Montaña»: décimo juego de lotería. Resultado = pareja ordenada de dos números distintos del 00 al 99
-- (9.900 resultados, tablero nuevo DUO). Dupleta exacta (EXACT) e invertida (REVERSED) activas; doble paridad (PARITY) pendiente.
ALTER TABLE lottery.modality DROP CONSTRAINT modality_code_check;
ALTER TABLE lottery.modality ADD CONSTRAINT modality_code_check
  CHECK (code IN ('EXACT', 'COMBINADA', 'MULTIPLE', 'TERMINAL', 'LAST_DIGIT', 'FULL', 'KINO5', 'KINO6', 'KINO7', 'APPROX', 'SUPER', 'DUAL',
                  'NUMBER', 'COLOR', 'PAIR', 'MATCH5', 'MATCH4', 'MATCH3', 'REVERSED', 'PARITY'));
ALTER TABLE lottery.game DROP CONSTRAINT game_board_check;
ALTER TABLE lottery.game ADD CONSTRAINT game_board_check CHECK (board IN ('SYMBOLS', 'DIGITS3', 'KINO', 'DIGITS2', 'COLOR', 'DIGITS4', 'DUO'));
