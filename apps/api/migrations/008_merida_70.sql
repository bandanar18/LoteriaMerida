-- MER-05 v2.0: un solo juego (Animalitos de Mérida), ampliado a 70 animales (00–69) con Animal exacto 50×.
-- RTP = 50/70 = 71,4 %. Las jugadas ya vendidas conservan el factor con que se vendieron.
-- Cada sorteo guarda en rng.rng_call cuántos animales había (range_n), así los sorteos de 37 siguen siendo verificables.

-- 1) Animales 37–69 (solo si MER-05 ya existe; en una base nueva los crea el seed).
INSERT INTO lottery.symbol (game_id, number, name, emoji, sort)
SELECT g.id, v.number, v.name, v.emoji, v.sort
  FROM lottery.game g
 CROSS JOIN (VALUES
  ('37', 'Delfín', '🐬', 37),
  ('38', 'Ballena', '🐋', 38),
  ('39', 'Tiburón', '🦈', 39),
  ('40', 'Pulpo', '🐙', 40),
  ('41', 'Cangrejo', '🦀', 41),
  ('42', 'Camarón', '🦐', 42),
  ('43', 'Pato', '🦆', 43),
  ('44', 'Pavo Real', '🦚', 44),
  ('45', 'Flamenco', '🦩', 45),
  ('46', 'Garza', '🪿', 46),
  ('47', 'Murciélago', '🦇', 47),
  ('48', 'Abeja', '🐝', 48),
  ('49', 'Mariposa', '🦋', 49),
  ('50', 'Araña', '🕷️', 50),
  ('51', 'Escorpión', '🦂', 51),
  ('52', 'Caracol', '🐌', 52),
  ('53', 'Culebra', '🐍', 53),
  ('54', 'Iguana', '🦎', 54),
  ('55', 'Oveja', '🐑', 55),
  ('56', 'Conejo', '🐇', 56),
  ('57', 'León', '🦁', 57),
  ('58', 'Tigre', '🐅', 58),
  ('59', 'Elefante', '🐘', 59),
  ('60', 'Jirafa', '🦒', 60),
  ('61', 'Cebra', '🦓', 61),
  ('62', 'Rinoceronte', '🦏', 62),
  ('63', 'Camello', '🐫', 63),
  ('64', 'Gorila', '🦍', 64),
  ('65', 'Canguro', '🦘', 65),
  ('66', 'Pingüino', '🐧', 66),
  ('67', 'Oso Panda', '🐼', 67),
  ('68', 'Koala', '🐨', 68),
  ('69', 'Mapache', '🦝', 69)
 ) AS v(number, name, emoji, sort)
 WHERE g.code = 'MER-05'
ON CONFLICT (game_id, number) DO NOTHING;

-- 2) Factor 50× y versión de reglas.
UPDATE lottery.modality m SET factor_x100 = 5000, description = 'Un animal y su número. Si sale, cobras 50× lo apostado.'
  FROM lottery.game g WHERE g.id = m.game_id AND g.code = 'MER-05' AND m.code = 'EXACT';
UPDATE lottery.game SET rules_version = 'MER-05 v2.0-borrador', payout_multiplier = 50.00 WHERE code = 'MER-05';

-- 3) Un solo juego: los demás se retiran (sus sorteos pendientes ya se anularon con reembolso antes de esta migración).
UPDATE lottery.game SET status = 'INACTIVE' WHERE code <> 'MER-05';
UPDATE lottery.schedule s SET active = false FROM lottery.game g WHERE g.id = s.game_id AND g.code <> 'MER-05';
-- Sorteos futuros sin jugadas de los juegos retirados (si quedara alguno): fuera.
UPDATE lottery.draw d SET status = 'CANCELLED', cancelled_reason = 'Juego retirado: solo queda Animalitos de Mérida'
  FROM lottery.game g
 WHERE g.id = d.game_id AND g.code <> 'MER-05' AND d.status IN ('SCHEDULED', 'OPEN', 'CLOSED')
   AND NOT EXISTS (SELECT 1 FROM lottery.play p WHERE p.draw_id = d.id);
