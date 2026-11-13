-- Más deportes para las cuotas externas: básquet (NBA, Euroliga…), hockey sobre hielo (NHL) y fútbol americano (NFL…).
ALTER TABLE sports.sport DROP CONSTRAINT IF EXISTS sport_code_check;
ALTER TABLE sports.sport ADD CONSTRAINT sport_code_check
  CHECK (code IN ('FOOTBALL', 'BASEBALL', 'BASKETBALL', 'ICE_HOCKEY', 'AMERICAN_FOOTBALL'));
INSERT INTO sports.sport (code, name) VALUES
  ('BASKETBALL', 'Básquet'), ('ICE_HOCKEY', 'Hockey'), ('AMERICAN_FOOTBALL', 'Fútbol americano')
ON CONFLICT (code) DO NOTHING;

-- Cuándo se consultó cada liga por última vez: el conector reparte los créditos del plan rotando entre ligas.
CREATE TABLE IF NOT EXISTS sports.feed_league (
  key       text PRIMARY KEY,
  synced_at timestamptz NOT NULL DEFAULT now()
);
