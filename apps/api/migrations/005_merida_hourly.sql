-- MER-05 v1.1: 12 sorteos diarios (09:00–20:00, uno por hora), Animal exacto 25× y tope por jugador.
-- El resultado sigue saliendo de forma aleatoria; el margen viene del factor publicado y el riesgo se acota con topes.

-- Tope de lo que un mismo jugador puede apostar en un sorteo (suma de sus jugadas), por moneda. NULL = sin tope.
ALTER TABLE lottery.game_limit ADD COLUMN max_player_per_draw bigint CHECK (max_player_per_draw > 0);

-- Lo de abajo solo aplica si MER-05 ya existe (en una base nueva lo crea el seed con estos valores).
UPDATE lottery.game_limit l SET max_player_per_draw = CASE l.currency WHEN 'VES' THEN 500000 ELSE 125000000 END
  FROM lottery.game g WHERE g.id = l.game_id AND g.code = 'MER-05';

-- Factor 25× (RTP 67,6 %). Las jugadas ya vendidas conservan el factor congelado con que se vendieron.
UPDATE lottery.modality m SET factor_x100 = 2500, description = 'Un animal y su número. Si sale, cobras 25× lo apostado.'
  FROM lottery.game g WHERE g.id = m.game_id AND g.code = 'MER-05' AND m.code = 'EXACT';
UPDATE lottery.game SET rules_version = 'MER-05 v1.1-borrador', payout_multiplier = 25.00 WHERE code = 'MER-05';

-- Calendario: 09:00 a 20:00 todos los días.
UPDATE lottery.schedule s SET active = (extract(hour FROM s.draw_time) BETWEEN 9 AND 20)
  FROM lottery.game g WHERE g.id = s.game_id AND g.code = 'MER-05';
INSERT INTO lottery.schedule (game_id, weekday, draw_time)
SELECT g.id, wd, make_time(h, 0, 0)
  FROM lottery.game g CROSS JOIN generate_series(0, 6) wd CROSS JOIN generate_series(9, 20) h
 WHERE g.code = 'MER-05'
ON CONFLICT (game_id, weekday, draw_time) DO UPDATE SET active = true;

-- Sorteos de las 21:00 ya generados y sin jugadas: salen del calendario.
UPDATE lottery.draw d SET status = 'CANCELLED', cancelled_reason = 'Cambio de calendario MER-05 v1.1 (12 sorteos de 09:00 a 20:00)'
  FROM lottery.game g
 WHERE g.id = d.game_id AND g.code = 'MER-05' AND NOT d.is_extraordinary
   AND d.status IN ('SCHEDULED', 'OPEN')
   AND extract(hour FROM d.draw_at AT TIME ZONE g.timezone) NOT BETWEEN 9 AND 20
   AND NOT EXISTS (SELECT 1 FROM lottery.play p WHERE p.draw_id = d.id);
