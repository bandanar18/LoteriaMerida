-- Triple Andino: 718 triple exacto y 718 terminal son jugadas distintas del mismo ticket y sorteo.
ALTER TABLE lottery.play DROP CONSTRAINT play_ticket_id_draw_id_symbol_id_key;
ALTER TABLE lottery.play ADD CONSTRAINT play_ticket_draw_symbol_modality_key UNIQUE (ticket_id, draw_id, symbol_id, modality_id);
