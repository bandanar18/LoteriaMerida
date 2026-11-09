-- MER-01 «Triple Andino»: tercer juego, números 000–999.
-- Cada jugada guarda el triple completo; la modalidad dice cuántas cifras finales se comparan con el resultado:
-- Triple exacto (EXACT) 3, Terminal 2, Última cifra 1. El juego y sus 1.000 números los crea el seed.
ALTER TABLE lottery.modality DROP CONSTRAINT modality_code_check;
ALTER TABLE lottery.modality ADD CONSTRAINT modality_code_check
  CHECK (code IN ('EXACT', 'COMBINADA', 'MULTIPLE', 'TERMINAL', 'LAST_DIGIT'));

-- Tablero del juego: símbolos con dibujo (Animalitos, Frutas) o número de tres cifras (Triple).
ALTER TABLE lottery.game ADD COLUMN board text NOT NULL DEFAULT 'SYMBOLS' CHECK (board IN ('SYMBOLS', 'DIGITS3'));
