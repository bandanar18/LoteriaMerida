CREATE TABLE lottery.market_band (
  draw_id uuid PRIMARY KEY REFERENCES lottery.draw (id) ON DELETE CASCADE,
  symbol_ids uuid[] NOT NULL CHECK (cardinality(symbol_ids) = 10 AND array_position(symbol_ids, NULL) IS NULL),
  updated_by uuid NOT NULL REFERENCES identity.app_user (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
