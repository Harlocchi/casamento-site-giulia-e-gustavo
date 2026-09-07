-- 001_init — tabelas do site de casamento (PostgreSQL)

-- Convidados. `qrcode` é um código curto (6 caracteres) sem letras/números
-- ambíguos (O, 0, I, 1, L), usado no convite / na entrada da festa.
CREATE TABLE guests (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  qrcode     TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Presentes que cada convidado deu (uma linha por cota presenteada).
CREATE TABLE gifts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guest_user_id BIGINT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  gift_name     TEXT NOT NULL,
  value         NUMERIC(12, 2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_gifts_guest_user_id ON gifts (guest_user_id);
