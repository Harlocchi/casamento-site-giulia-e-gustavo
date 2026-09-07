import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool, types } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

// node-postgres devolve NUMERIC e BIGINT como string por padrão — aqui a gente
// converte pra number (os valores deste projeto cabem tranquilo num Number).
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8 / bigint

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.warn(
    "\n⚠  DATABASE_URL não definida. Copie server/.env.example para server/.env " +
      "e aponte para o seu Postgres (ex.: postgres://user:senha@host:5432/banco).\n"
  );
}

function sslConfig() {
  const modo = (process.env.DATABASE_SSL || "auto").toLowerCase();
  if (modo === "disable" || modo === "false" || modo === "off") return false;
  if (modo === "require" || modo === "true" || modo === "on")
    return { rejectUnauthorized: false };
  // auto: SSL ligado, exceto quando o host é local
  try {
    const host = new URL(DATABASE_URL).hostname;
    if (["localhost", "127.0.0.1", "::1", ""].includes(host)) return false;
  } catch {
    /* URL ausente/inválida — deixa o pg reclamar na primeira query */
  }
  return { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: sslConfig(),
  max: Number(process.env.PGPOOL_MAX || 10),
  connectionTimeoutMillis: 10_000, // não fica pendurado se o banco não responde
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => console.error("Postgres pool:", err.message));

// atalho pra queries simples
const q = (text, params) => pool.query(text, params);

/* ------------------------------------------------------------------ *
 *  Migrações — roda os .sql de  migrations/  que ainda não passaram
 * ------------------------------------------------------------------ */
const MIGRATION_LOCK = 848_2026; // chave qualquer p/ o advisory lock

export async function migrate({ log = () => {} } = {}) {
  const client = await pool.connect();
  try {
    // trava pra dois deploys não migrarem ao mesmo tempo
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    } catch {
      /* pooler em modo transaction (ex.: Supabase 6543) pode não suportar — segue */
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query("SELECT version FROM schema_migrations");
    const aplicadas = new Set(rows.map((r) => r.version));

    const arquivos = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort(); // 001_, 002_, ... em ordem

    let n = 0;
    for (const arquivo of arquivos) {
      if (aplicadas.has(arquivo)) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, arquivo), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [arquivo]
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migração ${arquivo} falhou: ${e.message}`);
      }
      n++;
      log(`  ✓ ${arquivo}`);
    }
    return { aplicadas: n, total: arquivos.length };
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK])
      .catch(() => {});
    client.release();
  }
}

export async function migrationsStatus() {
  await q(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await q(
    "SELECT version, applied_at FROM schema_migrations ORDER BY version"
  );
  return rows;
}

/* ------------------------------------------------------------------ *
 *  QR code do convidado — 6 caracteres, sem caracteres ambíguos
 *  Removidos: O o 0 · I i 1 · L l   (fáceis de confundir)
 * ------------------------------------------------------------------ */
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export function gerarQrcode(tamanho = 6) {
  let s = "";
  for (let i = 0; i < tamanho; i++) s += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return s;
}

/* ------------------------------------------------------------------ *
 *  Convidados
 * ------------------------------------------------------------------ */
export async function criarConvidado(name) {
  const nome = String(name || "").trim();
  if (!nome) throw new Error("Nome obrigatório.");

  for (let tentativa = 0; tentativa < 10; tentativa++) {
    const qrcode = gerarQrcode();
    try {
      const { rows } = await q(
        "INSERT INTO guests (name, qrcode) VALUES ($1, $2) RETURNING id, name, qrcode",
        [nome, qrcode]
      );
      return rows[0];
    } catch (e) {
      if (e.code === "23505") continue; // unique_violation → colisão rara, tenta de novo
      throw e;
    }
  }
  throw new Error("Não foi possível gerar um qrcode único.");
}

export async function buscarConvidado(id) {
  const { rows } = await q(
    "SELECT id, name, qrcode, created_at FROM guests WHERE id = $1",
    [id]
  );
  return rows[0] || null;
}

export async function buscarConvidadoPorQrcode(qrcode) {
  const { rows } = await q(
    "SELECT id, name, qrcode, created_at FROM guests WHERE qrcode = $1",
    [String(qrcode || "").trim()]
  );
  return rows[0] || null;
}

export async function listarConvidados() {
  const { rows } = await q(
    `SELECT g.id, g.name, g.qrcode, g.created_at,
            COUNT(gi.id)::int          AS gifts_count,
            COALESCE(SUM(gi.value), 0) AS gifts_total
     FROM guests g
     LEFT JOIN gifts gi ON gi.guest_user_id = g.id
     GROUP BY g.id
     ORDER BY g.name`
  );
  return rows;
}

/* ------------------------------------------------------------------ *
 *  Presentes
 * ------------------------------------------------------------------ */
export async function registrarPresente({ guestUserId, giftName, value }) {
  const { rows } = await q(
    "INSERT INTO gifts (guest_user_id, gift_name, value) VALUES ($1, $2, $3) RETURNING id",
    [Number(guestUserId), String(giftName || "Presente"), Number(value) || 0]
  );
  return rows[0];
}

export async function presentesDoConvidado(guestUserId) {
  const { rows } = await q(
    "SELECT id, gift_name, value, created_at FROM gifts WHERE guest_user_id = $1 ORDER BY created_at",
    [Number(guestUserId)]
  );
  return rows;
}
