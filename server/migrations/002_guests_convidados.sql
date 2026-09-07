-- 002 — colunas da lista de convidados (planilha)
--   Numero      -> numero
--   Nome        -> name        (coluna que já existia)
--   code        -> qrcode      (coluna que já existia — mesmo propósito: código único do convite)
--   go_sit      -> go_sit      (vai à cerimônia / confirmado na planilha)
--   is_padrinho -> is_padrinho

ALTER TABLE guests ADD COLUMN numero      INTEGER;
ALTER TABLE guests ADD COLUMN go_sit      BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE guests ADD COLUMN is_padrinho BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX guests_numero_key ON guests (numero) WHERE numero IS NOT NULL;
