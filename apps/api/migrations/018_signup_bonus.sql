-- Bono de bienvenida por registro (aplicación DEMO): 10.000 Bs y 10 USDT de saldo de prueba.
-- Sale de una cuenta de promociones de la casa, siempre por el ledger de doble partida.
ALTER TABLE wallet.account DROP CONSTRAINT account_account_type_check;
ALTER TABLE wallet.account ADD CONSTRAINT account_account_type_check CHECK (account_type IN (
  'PLAYER_CASH', 'PLAYER_LOCKED', 'BETS_IN_PLAY', 'HOUSE_GGR', 'PAYMENT_CLEARING',
  'PLAYER_FUTURES', 'FUTURES_MARGIN', 'HOUSE_FUTURES_FEES', 'HOUSE_FUTURES_PNL',
  'HOUSE_PROMOTIONS'      -- bonos entregados a jugadores (costo de promoción)
));

-- Aceptación explícita de que es una aplicación DEMO sin valor real y sin comercialización.
ALTER TABLE identity.app_user ADD COLUMN demo_terms_accepted_at timestamptz;
