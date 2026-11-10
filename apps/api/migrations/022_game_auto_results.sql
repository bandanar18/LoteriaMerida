-- Resultado automático para los sorteos programados del calendario (por juego).
-- Con el interruptor encendido, cada sorteo del calendario nace con auto_rng = true: a su hora el resultado lo pone
-- el RNG provably fair con la semilla comprometida antes de la venta, sin carga manual ni acta.
ALTER TABLE lottery.game ADD COLUMN auto_rng boolean NOT NULL DEFAULT false;
