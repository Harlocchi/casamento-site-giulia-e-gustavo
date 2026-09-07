-- 004 — confirmações de presença (RSVP)

CREATE TABLE confirmacoes (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id             BIGINT      NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  confirmacao_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  status               TEXT        NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'CANCELLED'))
);

CREATE INDEX confirmacoes_guest_id_idx ON confirmacoes (guest_id);

-- no máximo uma confirmação ACTIVE por convidado (cancelar + reconfirmar mantém histórico)
CREATE UNIQUE INDEX confirmacoes_guest_active_key
  ON confirmacoes (guest_id) WHERE status = 'ACTIVE';
