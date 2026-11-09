-- Animalitos de Mérida (MER-05): modalidades, versión de reglas, modo demo, acta e incidencias.
-- Ver docs/Animalitos_de_Merida_MER-05.md §11.

-- ───────── Juego: atributos nuevos ─────────
ALTER TABLE lottery.game
  ADD COLUMN rules_version          text NOT NULL DEFAULT 'v1',
  ADD COLUMN is_demo                boolean NOT NULL DEFAULT false,      -- tickets «DEMO - NO CANJEABLE»
  ADD COLUMN requires_record        boolean NOT NULL DEFAULT false,      -- el resultado oficial exige acta
  ADD COLUMN publish_preliminary    boolean NOT NULL DEFAULT false,      -- mostrar resultado preliminar al público
  ADD COLUMN prize_expiry_days      integer CHECK (prize_expiry_days > 0), -- caducidad (canje POS); NULL = no aplica
  ADD COLUMN social_contribution_bps integer CHECK (social_contribution_bps BETWEEN 0 AND 10000), -- pendiente de cifra oficial
  ADD COLUMN display_order          integer NOT NULL DEFAULT 100;

-- ───────── Modalidades ─────────
CREATE TABLE lottery.modality (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id        uuid NOT NULL REFERENCES lottery.game (id),
  code           text NOT NULL CHECK (code IN ('EXACT', 'COMBINADA', 'MULTIPLE')),
  name           text NOT NULL,
  min_selections integer NOT NULL CHECK (min_selections >= 1),
  max_selections integer CHECK (max_selections IS NULL OR max_selections >= min_selections),
  factor_x100    bigint NOT NULL CHECK (factor_x100 > 0),  -- 3000 = 30×
  status         text NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('ACTIVE', 'PENDING_APPROVAL', 'INACTIVE')),
  description    text NOT NULL DEFAULT '',
  sort           integer NOT NULL DEFAULT 0,
  UNIQUE (game_id, code)
);

-- Juegos existentes: su única modalidad es el animal exacto con el factor del juego.
INSERT INTO lottery.modality (game_id, code, name, min_selections, max_selections, factor_x100, status, description)
SELECT id, 'EXACT', 'Animal exacto', 1, 1, (payout_multiplier * 100)::bigint, 'ACTIVE', 'Aciertas si sale tu animal.'
  FROM lottery.game;

-- ───────── Ticket y jugada: términos congelados al momento de la venta ─────────
ALTER TABLE lottery.ticket ADD COLUMN rules_version text NOT NULL DEFAULT 'v1';
ALTER TABLE lottery.play
  ADD COLUMN modality_id uuid REFERENCES lottery.modality (id),
  ADD COLUMN factor_x100 bigint;
UPDATE lottery.play p SET modality_id = m.id, factor_x100 = m.factor_x100
  FROM lottery.ticket t JOIN lottery.modality m ON m.game_id = t.game_id AND m.code = 'EXACT'
 WHERE t.id = p.ticket_id;
ALTER TABLE lottery.play
  ALTER COLUMN modality_id SET NOT NULL,
  ALTER COLUMN factor_x100 SET NOT NULL,
  ADD CHECK (factor_x100 > 0);

-- ───────── Catálogo: un animal vendido no puede cambiar de número ni de nombre ─────────
CREATE FUNCTION lottery.symbol_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM lottery.play WHERE symbol_id = OLD.id) THEN
    IF TG_OP = 'DELETE' OR NEW.number <> OLD.number OR NEW.name <> OLD.name THEN
      RAISE EXCEPTION 'El animal % % ya tiene jugadas: el catálogo publicado es inmutable', OLD.number, OLD.name;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER symbol_locked BEFORE UPDATE OR DELETE ON lottery.symbol
  FOR EACH ROW EXECUTE FUNCTION lottery.symbol_locked();

-- ───────── Acta del sorteo (certificación del resultado) ─────────
CREATE TABLE lottery.draw_record (
  draw_id       uuid PRIMARY KEY REFERENCES lottery.draw (id),
  record_number text NOT NULL,
  executor      text NOT NULL,   -- quien ejecuta el sorteo
  inspector     text NOT NULL,   -- fiscal / fedatario
  notes         text,
  file_key      text,            -- archivo cifrado (AES-256-GCM)
  file_iv       text,
  file_tag      text,
  file_sha256   text,
  file_mime     text,
  created_by    uuid NOT NULL REFERENCES identity.app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((file_key IS NULL) = (file_sha256 IS NULL))
);
CREATE TRIGGER draw_record_immutable BEFORE UPDATE OR DELETE ON lottery.draw_record
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

-- ───────── Incidencias del sorteo ─────────
CREATE TABLE lottery.draw_incident (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id       uuid NOT NULL REFERENCES lottery.draw (id),
  kind          text NOT NULL CHECK (kind IN ('HUMAN', 'MECHANICAL', 'IT', 'COMMUNICATIONS', 'CANCELLATION', 'OTHER')),
  description   text NOT NULL,
  responsible   text NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  public_notice text,             -- comunicado al público (se muestra en resultados)
  resolution    text,
  resolved_at   timestamptz,
  created_by    uuid REFERENCES identity.app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((resolution IS NULL) = (resolved_at IS NULL))
);
CREATE INDEX draw_incident_draw_idx ON lottery.draw_incident (draw_id, occurred_at);
