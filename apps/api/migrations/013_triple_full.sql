-- Triple Andino «Las 3» (FULL): una jugada participa en triple, terminal y última cifra y cobra solo el premio mayor.
ALTER TABLE lottery.modality DROP CONSTRAINT modality_code_check;
ALTER TABLE lottery.modality ADD CONSTRAINT modality_code_check
  CHECK (code IN ('EXACT', 'COMBINADA', 'MULTIPLE', 'TERMINAL', 'LAST_DIGIT', 'FULL'));
