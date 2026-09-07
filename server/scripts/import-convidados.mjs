/**
 * Importa/atualiza a lista de convidados a partir de um CSV.
 *
 *   node scripts/import-convidados.mjs [caminho.csv]
 *
 * Padrão: server/data/lista_convidados.csv
 * Colunas esperadas: Numero,Nome,go_sit,is_padrinho,code
 * Casa por `code` (= qrcode). Quem já está no banco é atualizado.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importarConvidados, pool } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvPath =
  process.argv[2] || path.join(__dirname, "..", "data", "lista_convidados.csv");

// parser de CSV simples (sem aspas/vírgula dentro de campo — a lista não tem)
function parseCsv(texto) {
  const linhas = texto.replace(/\r/g, "").trim().split("\n");
  const cab = linhas.shift().split(",");
  return linhas
    .filter(Boolean)
    .map((l) => Object.fromEntries(l.split(",").map((v, i) => [cab[i], v])));
}

try {
  const registros = parseCsv(readFileSync(csvPath, "utf8"));
  console.log(`Lendo ${registros.length} linhas de ${csvPath}`);
  const r = await importarConvidados(registros);
  console.log(`\n✓ ${r.importados} importados/atualizados` + (r.ignorados ? ` · ${r.ignorados} ignorados (sem code/nome)` : ""));
} catch (err) {
  console.error("\n✖", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
