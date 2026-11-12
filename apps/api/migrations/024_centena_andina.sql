-- MER-06 «Centena Andina»: séptimo juego de lotería, centenas 000–999 (tablero DIGITS3, como Triple Andino).
-- Modalidades: Centena exacta (EXACT), Aproximación (TERMINAL: dos últimas cifras en orden) y Par andino
-- (PAIR, nuevo: dos últimas cifras en cualquier orden).
ALTER TABLE lottery.modality DROP CONSTRAINT modality_code_check;
ALTER TABLE lottery.modality ADD CONSTRAINT modality_code_check
  CHECK (code IN ('EXACT', 'COMBINADA', 'MULTIPLE', 'TERMINAL', 'LAST_DIGIT', 'FULL', 'KINO5', 'KINO6', 'KINO7', 'APPROX', 'SUPER', 'DUAL',
                  'NUMBER', 'COLOR', 'PAIR'));
