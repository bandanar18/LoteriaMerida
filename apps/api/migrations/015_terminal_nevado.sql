-- MER-04 «Terminal Nevado»: quinto juego, números 00–99.
-- Terminal directo (EXACT) y Aproximación (APPROX: gana si sale el número anterior o el siguiente, sin dar la vuelta 99→00).
-- Súper terminal (SUPER) queda pendiente: el manual (Anexo B.1) no define su condición.
ALTER TABLE lottery.modality DROP CONSTRAINT modality_code_check;
ALTER TABLE lottery.modality ADD CONSTRAINT modality_code_check
  CHECK (code IN ('EXACT', 'COMBINADA', 'MULTIPLE', 'TERMINAL', 'LAST_DIGIT', 'FULL', 'KINO5', 'KINO6', 'KINO7', 'APPROX', 'SUPER'));
ALTER TABLE lottery.game DROP CONSTRAINT game_board_check;
ALTER TABLE lottery.game ADD CONSTRAINT game_board_check CHECK (board IN ('SYMBOLS', 'DIGITS3', 'KINO', 'DIGITS2'));
