import "dotenv/config";
import { migrate, migrationsStatus, pool } from "./db.js";

const cmd = process.argv[2];

try {
  if (cmd === "status") {
    const rows = await migrationsStatus();
    console.log(
      rows.length
        ? rows
            .map((r) => `  ${r.version}   ${new Date(r.applied_at).toISOString()}`)
            .join("\n")
        : "  (nenhuma migração aplicada ainda)"
    );
  } else {
    console.log("Rodando migrações...");
    const { aplicadas, total } = await migrate({ log: (m) => console.log(m) });
    console.log(
      aplicadas
        ? `\n${aplicadas} nova(s) aplicada(s) — ${total} migração(ões) no total.`
        : "Banco já estava atualizado."
    );
  }
} catch (err) {
  console.error("\nErro:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
