-- Terminal Nevado «Las 2» (DUAL): un número juega directo y aproximación y cobra un solo premio.
ALTER TABLE lottery.modality DROP CONSTRAINT modality_code_check;
ALTER TABLE lottery.modality ADD CONSTRAINT modality_code_check
  CHECK (code IN ('EXACT', 'COMBINADA', 'MULTIPLE', 'TERMINAL', 'LAST_DIGIT', 'FULL', 'KINO5', 'KINO6', 'KINO7', 'APPROX', 'SUPER', 'DUAL'));
