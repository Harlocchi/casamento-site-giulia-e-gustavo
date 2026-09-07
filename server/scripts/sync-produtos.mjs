/**
 * Sincroniza as cotas do index.html com o catálogo de Produtos da AbacatePay.
 *
 *   node scripts/sync-produtos.mjs            # cria o que falta
 *   node scripts/sync-produtos.mjs --dry-run  # só mostra o que faria
 *   node scripts/sync-produtos.mjs --force    # recria produtos cujo preço/nome mudou
 *   node scripts/sync-produtos.mjs --delete-orphans   # remove produtos que não existem mais no site
 *
 * O `externalId` de cada produto = o `id` da cota (ex.: "lua-de-mel", "ps5").
 * A chave usada (ABACATEPAY_API_KEY no .env) decide se é dev mode ou produção.
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, "..", "..");
const INDEX_HTML = path.join(SITE_DIR, "index.html");
const FOTOS_DIR = path.join(SITE_DIR, "fotos");

// Se definido (ex.: SITE_URL=https://casamento.fly.dev), o script usa a foto
// local  fotos/<id>.<ext>  como imageUrl do produto — servida por esse site.
// A AbacatePay valida a URL na criação, então o site já precisa estar no ar.
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");
const EXTS = ["jpg", "jpeg", "png", "webp"];
const API = "https://api.abacatepay.com/v2";
// O catálogo de Produtos é da API v2 — exige uma chave v2 (o painel gera à parte).
// Sua chave do fluxo Pix atual (server.js) é v1 e dá "API key version mismatch" aqui.
const KEY = process.env.ABACATEPAY_API_KEY_V2 || process.env.ABACATEPAY_API_KEY;

const flags = new Set(process.argv.slice(2));
const DRY = flags.has("--dry-run");
const FORCE = flags.has("--force");
const DELETE_ORPHANS = flags.has("--delete-orphans");

if (!KEY || KEY.startsWith("abc_dev_troque") || KEY.includes("SUACHAVE")) {
  console.error(
    "✖ Configure ABACATEPAY_API_KEY_V2 em server/.env (uma chave da API v2 — o\n" +
      "  catálogo de Produtos só existe na v2). A chave v1 do Pix não serve aqui."
  );
  process.exit(1);
}

const brl = (cents) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/* ---- lê as COTAS direto do index.html (fonte única da lista) ---- */
function lerCotas() {
  const html = readFileSync(INDEX_HTML, "utf8");
  const m = html.match(/const COTAS = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error("Não achei 'const COTAS = [...]' no index.html.");
  // o literal só tem strings e números — é um arquivo nosso, avaliação controlada
  const cotas = Function(`"use strict";return (${m[1]});`)();
  const produtos = cotas.map((c) => {
    const p = {
      externalId: String(c.id),
      name: String(c.titulo),
      price: Math.round(Number(c.valor) * 100),
      currency: "BRL",
    };
    if (c.desc) p.description = String(c.desc);

    // 1º: foto já é URL absoluta no index.html
    if (typeof c.foto === "string" && /^https?:\/\//.test(c.foto)) {
      p.imageUrl = c.foto;
    } else if (SITE_URL) {
      // 2º: fotos/<id>.<ext> local → URL servida pelo SITE_URL
      const ext = EXTS.find((e) => existsSync(path.join(FOTOS_DIR, `${c.id}.${e}`)));
      if (ext) p.imageUrl = `${SITE_URL}/fotos/${c.id}.${ext}`;
    }
    return p;
  });

  // Produto especial da "Contribuição livre": R$ 1,00 e o checkout usa
  // quantity = valor em reais. Não aparece como card no site.
  produtos.push({
    externalId: "contribuicao-livre",
    name: "Contribuição livre para os noivos",
    price: 100,
    currency: "BRL",
    description: "Cada unidade equivale a R$ 1,00.",
  });

  return produtos;
}

async function api(pathname, { method = "GET", body } = {}) {
  const res = await fetch(API + pathname, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false || json.error) {
    throw new Error(
      `${method} ${pathname} → ${res.status} ${json.error || res.statusText}`
    );
  }
  return json.data;
}

// cria o produto; se a AbacatePay recusar a imagem, tenta de novo sem ela
async function criarProduto(cota) {
  try {
    return await api("/products/create", { method: "POST", body: cota });
  } catch (e) {
    if (cota.imageUrl && /image url/i.test(e.message)) {
      const { imageUrl, ...semImagem } = cota;
      const p = await api("/products/create", { method: "POST", body: semImagem });
      console.log(`  (imagem recusada pela AbacatePay — produto criado sem imagem)`);
      return p;
    }
    throw e;
  }
}

/* ---- lista o catálogo (paginando por cursor, se precisar) ---- */
async function listarProdutos() {
  const todos = [];
  let after;
  for (let i = 0; i < 50; i++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);
    const pagina = await api(`/products/list?${qs}`);
    const itens = Array.isArray(pagina) ? pagina : [];
    todos.push(...itens);
    if (itens.length < 100) break;
    after = itens[itens.length - 1]?.id;
    if (!after) break;
  }
  return todos;
}

function mudou(produtoAtual, cota) {
  const atualImg = produtoAtual.imageUrl || produtoAtual.image || "";
  return (
    produtoAtual.price !== cota.price ||
    produtoAtual.name !== cota.name ||
    (produtoAtual.description || "") !== (cota.description || "") ||
    // só sinaliza a imagem quando TEMOS uma nova pra pôr e ela é diferente
    // (não mexe em quem já tem imagem subida pelo painel)
    (Boolean(cota.imageUrl) && cota.imageUrl !== atualImg)
  );
}

async function main() {
  const cotas = lerCotas();
  const catalogo = await listarProdutos();
  const porExternal = new Map(catalogo.filter((p) => p.externalId).map((p) => [p.externalId, p]));

  console.log(
    `\n${cotas.length} cotas no site · ${catalogo.length} produtos na AbacatePay` +
      `${DRY ? "   [DRY-RUN]" : ""}\n`
  );

  let criados = 0,
    recriados = 0,
    iguais = 0,
    pendentes = 0;

  for (const cota of cotas) {
    const atual = porExternal.get(cota.externalId);
    const tag = cota.externalId.padEnd(16);

    if (!atual) {
      if (DRY) {
        console.log(`+ criar     ${tag} ${cota.name}  ${brl(cota.price)}`);
      } else {
        try {
          const novo = await criarProduto(cota);
          console.log(`+ criado    ${tag} ${novo.id}  ${brl(cota.price)}`);
        } catch (e) {
          if (/already exists/i.test(e.message)) {
            // a listagem da AbacatePay ainda não tinha atualizado — já existe, tudo bem
            console.log(`= já existe ${tag} (rode de novo pra confirmar)`);
            iguais++;
            continue;
          }
          throw e;
        }
      }
      criados++;
      continue;
    }

    if (!mudou(atual, cota)) {
      console.log(`= ok        ${tag} ${atual.id}`);
      iguais++;
      continue;
    }

    if (!FORCE) {
      console.log(
        `~ mudou     ${tag} ${atual.id}  ${brl(atual.price)} → ${brl(cota.price)}` +
          `   (rode com --force pra recriar)`
      );
      pendentes++;
      continue;
    }

    if (DRY) {
      console.log(`~ recriar   ${tag} ${atual.id}`);
    } else {
      await api("/products/delete", { method: "POST", body: { id: atual.id } });
      const novo = await criarProduto(cota);
      console.log(`~ recriado  ${tag} ${atual.id} → ${novo.id}`);
    }
    recriados++;
  }

  if (DELETE_ORPHANS) {
    const idsCotas = new Set(cotas.map((c) => c.externalId));
    for (const p of catalogo) {
      if (!p.externalId || idsCotas.has(p.externalId)) continue;
      if (DRY) {
        console.log(`- órfão     ${String(p.externalId).padEnd(16)} ${p.id}`);
      } else {
        await api("/products/delete", { method: "POST", body: { id: p.id } });
        console.log(`- deletado  ${String(p.externalId).padEnd(16)} ${p.id}`);
      }
    }
  }

  console.log(
    `\nResumo: ${criados} a criar/criados · ${recriados} recriados · ${iguais} já ok` +
      (pendentes ? ` · ${pendentes} com mudança pendente (--force)` : "") +
      (DRY ? "   [nada foi enviado — DRY-RUN]" : "")
  );
}

main().catch((e) => {
  console.error("\n✖", e.message);
  process.exit(1);
});
