-- Modalidades que los manuales dejaban pendientes, ya definidas y activas (DEMO):
--   Centena Andina (MER-06): Aproximación (2 últimas cifras en orden, 40×) y Par andino (2 últimas en cualquier orden, 20×).
--   Cuatrifecta de Cumbres (MER-08): Terminal 4 cifras = las 4 cifras en cualquier orden (BOX, 300×) y Aproximación (±1, 100×).
--   Dupleta de Montaña (MER-07): Doble paridad = apuesta a «ambos pares» o «ambos impares», 3× (a 20× devolvía ~495 %).
--   Andes 5 Estrella (MER-10): estrella del 1 al 5; cada modalidad tiene su versión con estrella que paga ×5.
ALTER TABLE lottery.modality DROP CONSTRAINT modality_code_check;
ALTER TABLE lottery.modality ADD CONSTRAINT modality_code_check
  CHECK (code IN ('EXACT', 'COMBINADA', 'MULTIPLE', 'TERMINAL', 'LAST_DIGIT', 'FULL', 'KINO5', 'KINO6', 'KINO7', 'APPROX', 'SUPER', 'DUAL',
                  'NUMBER', 'COLOR', 'PAIR', 'MATCH5', 'MATCH4', 'MATCH3', 'REVERSED', 'PARITY', 'BOX', 'MATCH5S', 'MATCH4S', 'MATCH3S'));

-- Estrella: máximo por juego, la extraída en cada sorteo y la elegida en cada jugada.
ALTER TABLE lottery.game ADD COLUMN star_max smallint CHECK (star_max BETWEEN 1 AND 9);
ALTER TABLE lottery.draw ADD COLUMN result_star smallint, ADD COLUMN proposed_star smallint;
ALTER TABLE lottery.play ADD COLUMN star smallint;

UPDATE lottery.modality m SET status = 'ACTIVE',
       description = CASE m.code
         WHEN 'TERMINAL' THEN 'Aciertas las dos últimas cifras en el mismo orden (09 gana si sale 009, 109, 209…). Cobras 40× lo apostado.'
         ELSE 'Aciertas las dos últimas cifras en cualquier orden (90 gana si termina en 90 o en 09). Cobras 20× lo apostado.' END
  FROM lottery.game g WHERE g.id = m.game_id AND g.code = 'MER-06' AND m.code IN ('TERMINAL', 'PAIR');

UPDATE lottery.modality m SET code = 'BOX', status = 'ACTIVE',
       description = 'Aciertas tus cuatro cifras en cualquier orden (1234 gana si sale 4321, 2143…). Cobras 300× lo apostado.'
  FROM lottery.game g WHERE g.id = m.game_id AND g.code = 'MER-08' AND m.code = 'SUPER';
UPDATE lottery.modality m SET status = 'ACTIVE',
       description = 'Ganas si sale el número inmediatamente anterior o posterior al tuyo (juegas 1234: gana con 1233 o 1235; 0000 y 9999 tienen un solo vecino). Cobras 100× lo apostado.'
  FROM lottery.game g WHERE g.id = m.game_id AND g.code = 'MER-08' AND m.code = 'APPROX';

UPDATE lottery.modality m SET status = 'ACTIVE', factor_x100 = 300,
       description = 'Apuestas a que los dos números salen pares, o a que salen impares. Si aciertas, cobras 3× lo apostado.'
  FROM lottery.game g WHERE g.id = m.game_id AND g.code = 'MER-07' AND m.code = 'PARITY';

UPDATE lottery.game SET star_max = 5 WHERE code = 'MER-10';
INSERT INTO lottery.modality (game_id, code, name, min_selections, max_selections, factor_x100, status, description, sort)
SELECT g.id, x.code, x.name, 5, 5, x.factor, 'ACTIVE', x.description, x.sort
  FROM lottery.game g
  CROSS JOIN (VALUES
    ('MATCH5S', '5 exactos + estrella', 2500000, 'Tus cinco números y tu estrella. Cobras 25.000× lo apostado.', 3),
    ('MATCH4S', '4 aciertos + estrella', 500000, 'Exactamente 4 de tus números y tu estrella. Cobras 5.000× lo apostado.', 4),
    ('MATCH3S', '3 aciertos + estrella', 25000, 'Exactamente 3 de tus números y tu estrella. Cobras 250× lo apostado.', 5)
  ) AS x(code, name, factor, description, sort)
 WHERE g.code = 'MER-10'
ON CONFLICT (game_id, code) DO NOTHING;
