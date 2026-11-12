-- Registro lite (DEMO, Agencias Virtuales): quien llega por el QR de una agencia juega primero y se registra
-- solo con nombre, correo, teléfono y contraseña. Cédula y fecha de nacimiento quedan para después
-- (se piden antes de retirar, que ya exige verificación nivel 2).
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'identity.app_user'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%document_number IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE identity.app_user DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE identity.app_user
  ADD CONSTRAINT app_user_player_required CHECK (kind <> 'PLAYER' OR (role = 'PLAYER' AND phone IS NOT NULL));

-- Marca de cuentas creadas con el registro lite (pendientes de completar documento y nacimiento).
ALTER TABLE identity.app_user ADD COLUMN lite_signup boolean NOT NULL DEFAULT false;
