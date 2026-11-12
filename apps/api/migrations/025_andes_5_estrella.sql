-- MER-10 «Andes 5 Estrella»: octavo juego de lotería. Se eligen 5 números del 01 al 40 y se extraen 5 (tablero KINO, draw_count 5).
-- Modalidades por aciertos exactos: 5 números exactos (MATCH5), 4 aciertos (MATCH4) y 3 aciertos (MATCH3).
-- La estrella no se implementa: el manual (Anexo B.1) no define su rango, extracción ni premio.
ALTER TABLE lottery.modality DROP CONSTRAINT modality_code_check;
ALTER TABLE lottery.modality ADD CONSTRAINT modality_code_check
  CHECK (code IN ('EXACT', 'COMBINADA', 'MULTIPLE', 'TERMINAL', 'LAST_DIGIT', 'FULL', 'KINO5', 'KINO6', 'KINO7', 'APPROX', 'SUPER', 'DUAL',
                  'NUMBER', 'COLOR', 'PAIR', 'MATCH5', 'MATCH4', 'MATCH3'));
