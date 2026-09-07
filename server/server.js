import { readFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import "dotenv/config";
import {
  migrate,
  criarConvidado,
  importarConvidados,
  listarConvidados,
  buscarConvidadoPorQrcode,
  registrarPresente,
  presentesDoConvidado,
} from "./db.js";

/* ------------------------------------------------------------------ *
 *  Configuração
 * ------------------------------------------------------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, ".."); // onde está o index.html
const DADOS_DIR = path.join(__dirname, "dados"); // logs (fora do git)

const {
  ABACATEPAY_API_KEY,
  ABACATEPAY_WEBHOOK_SECRET,
  ADMIN_TOKEN,
  ABACATEPAY_DEV = "0",
  SITE_URL = "",
  PORT = "3000",
} = process.env;

const ABACATE_BASE = "https://api.abacatepay.com/v2";
const DEV = ABACATEPAY_DEV === "1";
const SITE = SITE_URL.replace(/\/$/, "");

// Chave pública da AbacatePay p/ validar a assinatura HMAC dos webhooks (doc oficial).
const ABACATE_WEBHOOK_PUBLIC_KEY =
  "t9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9";

if (!ABACATEPAY_API_KEY) {
  console.warn(
    "\n⚠  ABACATEPAY_API_KEY não definida (server/.env). É a chave da API v2.\n" +
      "   Sem ela, o botão 'Presentear' vai falhar ao gerar o link de pagamento.\n"
  );
}

/* ------------------------------------------------------------------ *
 *  Cliente AbacatePay v2 — a chave secreta nunca sai daqui
 * ------------------------------------------------------------------ */
async function abacate(pathname, { method = "GET", body } = {}) {
  const res = await fetch(ABACATE_BASE + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${ABACATEPAY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false || json.error) {
    throw new Error(
      `AbacatePay ${method} ${pathname} → ${res.status} ${json.error || res.statusText}`
    );
  }
  return json.data ?? json;
}

/* Cache: externalId da cota (ex.: "ps5") -> { id: "prod_...", price: centavos }.
 * Preenchido a partir do catálogo de Produtos (npm run produtos:sync). */
let _catalogo = null;
let _catalogoAt = 0;
async function produtoDaCota(cotaId, { forcar = false } = {}) {
  if (forcar || !_catalogo || Date.now() - _catalogoAt > 5 * 60_000) {
    const lista = await abacate("/products/list?limit=100");
    _catalogo = new Map(
      (Array.isArray(lista) ? lista : []).map((p) => [
        p.externalId,
        { id: p.id, price: p.price },
      ])
    );
    _catalogoAt = Date.now();
  }
  return _catalogo.get(cotaId);
}

// nº máximo de parcelas: 1..12, respeitando o mínimo de R$ 10 por parcela
const maxParcelas = (totalCentavos) =>
  Math.max(1, Math.min(12, Math.floor(totalCentavos / 1000)));

// externalId da cobrança carrega cota + convidado, pra voltar no webhook
const montarExternalId = (cotaId, guestId) =>
  `cota:${cotaId}|guest:${guestId ?? "-"}|${crypto.randomBytes(4).toString("hex")}`;
function lerExternalId(ext = "") {
  const m = /cota:([^|]*)\|guest:([^|]*)/.exec(ext || "");
  if (!m) return { cotaId: null, guestUserId: null };
  const g = m[2] && m[2] !== "-" ? Number(m[2]) : null;
  return { cotaId: m[1] || null, guestUserId: Number.isFinite(g) ? g : null };
}

// Validação HMAC-SHA256 da assinatura do webhook (header X-Webhook-Signature)
function assinaturaWebhookValida(rawBody, assinatura) {
  if (!assinatura) return false;
  const esperado = crypto
    .createHmac("sha256", ABACATE_WEBHOOK_PUBLIC_KEY)
    .update(rawBody || Buffer.alloc(0))
    .digest("base64");
  const a = Buffer.from(esperado);
  const b = Buffer.from(String(assinatura));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ *
 *  Persistência simples — um JSON por linha (.jsonl)
 * ------------------------------------------------------------------ */
async function registrar(arquivo, registro) {
  await mkdir(DADOS_DIR, { recursive: true });
  await appendFile(
    path.join(DADOS_DIR, arquivo),
    JSON.stringify({ ...registro, ts: new Date().toISOString() }) + "\n"
  );
}

async function listar(arquivo) {
  const f = path.join(DADOS_DIR, arquivo);
  if (!existsSync(f)) return [];
  const txt = await readFile(f, "utf8");
  return txt
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/* ------------------------------------------------------------------ *
 *  App
 * ------------------------------------------------------------------ */
const app = express();
// guarda o corpo cru p/ validar a assinatura HMAC do webhook
app.use(
  express.json({
    limit: "100kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Middleware: exige  Authorization: Bearer <ADMIN_TOKEN>
function exigirAdmin(req, res, next) {
  if (!ADMIN_TOKEN || req.get("authorization") !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: "Não autorizado." });
  }
  next();
}

/* ------------------------------------------------------------------ *
 *  Convidados (tabela guests)
 * ------------------------------------------------------------------ */

// Cadastra um convidado e gera o qrcode de 6 caracteres  [admin]
app.post("/api/guests", exigirAdmin, async (req, res) => {
  try {
    const convidado = await criarConvidado(req.body?.name);
    res.status(201).json(convidado); // { id, name, qrcode }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Carga em lote da lista de convidados  [admin]
// body: { guests: [ { numero, name|nome|Nome, code|qrcode, go_sit, is_padrinho } ] }
// Casa por `qrcode` (o código do convite): quem já existe é atualizado.
app.post("/api/guests/import", exigirAdmin, async (req, res) => {
  const linhas = Array.isArray(req.body?.guests) ? req.body.guests : null;
  if (!linhas || !linhas.length) {
    return res.status(400).json({ error: "Envie { guests: [ ... ] }." });
  }
  try {
    const r = await importarConvidados(linhas);
    res.json({ ...r, total: linhas.length });
  } catch (err) {
    console.error("guests/import:", err.message);
    res.status(500).json({ error: "Falha ao importar." });
  }
});

// Lista os convidados com total já presenteado  [admin]
app.get("/api/guests", exigirAdmin, async (_req, res) => {
  try {
    res.json(await listarConvidados());
  } catch (err) {
    console.error("guests/list:", err.message);
    res.status(500).json({ error: "Falha ao listar." });
  }
});

// Consulta pública por qrcode (o convidado vê o próprio cadastro / check-in)
app.get("/api/guests/:qrcode", async (req, res) => {
  try {
    const convidado = await buscarConvidadoPorQrcode(req.params.qrcode);
    if (!convidado)
      return res.status(404).json({ error: "Código não encontrado." });
    res.json({
      ...convidado,
      presentes: await presentesDoConvidado(convidado.id),
    });
  } catch (err) {
    console.error("guests/get:", err.message);
    res.status(500).json({ error: "Falha na consulta." });
  }
});

/* ---- Gera o link de pagamento (checkout hospedado) de uma cota ----
 * Métodos: PIX + Cartão de crédito parcelado (até 12x, mín. R$ 10/parcela).
 * O front redireciona o convidado para a `url` devolvida.
 */
app.post("/api/checkout/create", async (req, res) => {
  try {
    const { cotaId, valor, qrcode } = req.body || {};
    if (!cotaId) return res.status(400).json({ error: "cotaId obrigatório." });

    const isLivre = cotaId === "livre";
    const externalIdProduto = isLivre ? "contribuicao-livre" : cotaId;

    let produto = await produtoDaCota(externalIdProduto);
    if (!produto) produto = await produtoDaCota(externalIdProduto, { forcar: true });
    if (!produto) {
      return res.status(400).json({
        error:
          "Produto não encontrado no catálogo da AbacatePay. Rode: npm run produtos:sync",
      });
    }

    // Contribuição livre: produto de R$ 1,00, quantidade = valor em reais.
    let quantity = 1;
    let totalCentavos = produto.price;
    if (isLivre) {
      const reais = Math.round(Number(valor));
      if (!Number.isFinite(reais) || reais < 10 || reais > 100000) {
        return res.status(400).json({ error: "Valor inválido (mínimo R$ 10)." });
      }
      quantity = reais;
      totalCentavos = reais * 100;
    }

    const convidado = qrcode ? await buscarConvidadoPorQrcode(qrcode) : null;
    const externalId = montarExternalId(cotaId, convidado?.id);
    const site = SITE || `${req.protocol}://${req.get("host")}`;

    const checkout = await abacate("/checkouts/create", {
      method: "POST",
      body: {
        items: [{ id: produto.id, quantity }],
        methods: ["PIX", "CARD"],
        card: { maxInstallments: maxParcelas(totalCentavos) },
        externalId,
        completionUrl: `${site}/?obrigado=${encodeURIComponent(cotaId)}`,
        returnUrl: `${site}/#presentes`,
        metadata: { cotaId, guestUserId: convidado?.id ?? null },
      },
    });

    await registrar("cobrancas.jsonl", {
      id: checkout.id,
      externalId,
      cotaId,
      guestUserId: convidado?.id ?? null,
      amount: checkout.amount,
      url: checkout.url,
    });

    res.json({ id: checkout.id, url: checkout.url });
  } catch (err) {
    console.error("checkout/create:", err.message);
    res.status(502).json({ error: "Não foi possível gerar o link de pagamento." });
  }
});

/* ---- Status de um checkout (consulta pontual, se o front quiser) ---- */
app.get("/api/checkout/status/:id", async (req, res) => {
  try {
    const d = await abacate(
      `/checkouts/get?id=${encodeURIComponent(req.params.id)}`
    );
    res.json({
      status: d.status || "PENDING",
      method: (d.methods || [])[0] || null,
      installmentsCount: d.installmentsCount || null,
    });
  } catch (err) {
    console.error("checkout/status:", err.message);
    res.status(502).json({ error: "Falha ao consultar o status." });
  }
});

/* ---- Webhook da AbacatePay (v2) ----
 * No painel, cadastre a URL como:
 *   https://SEU_DOMINIO/api/webhook/abacatepay?webhookSecret=SEU_SEGREDO
 * (o mesmo valor de ABACATEPAY_WEBHOOK_SECRET no .env)
 */
const _eventosProcessados = new Set(); // idempotência em memória

app.post("/api/webhook/abacatepay", async (req, res) => {
  // 1) secret na URL
  if (
    !ABACATEPAY_WEBHOOK_SECRET ||
    req.query.webhookSecret !== ABACATEPAY_WEBHOOK_SECRET
  ) {
    return res.status(401).end();
  }
  // 2) assinatura HMAC (em produção é obrigatória; em dev, simulações podem não assinar)
  const assinado = assinaturaWebhookValida(
    req.rawBody,
    req.get("x-webhook-signature")
  );
  if (!assinado && !DEV) return res.status(401).end();

  const evt = req.body || {};
  if (evt.id && _eventosProcessados.has(evt.id)) return res.json({ ok: true });
  if (evt.id) _eventosProcessados.add(evt.id);

  await registrar("webhooks.jsonl", {
    id: evt.id || null,
    event: evt.event || null,
    devMode: evt.devMode ?? null,
    assinado,
  });

  const isCheckoutPago =
    (evt.event === "checkout.completed" || evt.event === "transparent.completed") &&
    String(evt.data?.checkout?.status || "").toUpperCase() === "PAID";

  if (isCheckoutPago) {
    const c = evt.data.checkout;
    const { cotaId, guestUserId } = lerExternalId(c.externalId);
    const valor = (c.paidAmount || c.amount || 0) / 100;
    const metodo = (c.methods || [])[0] || null;

    await registrar("presentes.jsonl", {
      id: c.id,
      cotaId,
      guestUserId,
      valor,
      metodo,
      parcelas: c.installmentsCount || null,
      pagador: evt.data.customer?.name || null,
    });

    if (guestUserId) {
      try {
        await registrarPresente({
          guestUserId,
          giftName: cotaId || "Presente",
          value: valor,
        });
      } catch (e) {
        console.error("gifts insert:", e.message);
      }
    }

    console.log(
      `🎁 Presente confirmado — ${c.id} — R$ ${valor.toFixed(2)} — ${metodo}` +
        (c.installmentsCount ? ` ${c.installmentsCount}x` : "")
    );
    // TODO: e-mail / WhatsApp pros noivos, se quiser.
  }

  res.json({ ok: true });
});

/* ---- Painel simples: lista de presentes recebidos (protegido por token) ---- */
app.get("/api/presentes", exigirAdmin, async (_req, res) => {
  const presentes = await listar("presentes.jsonl");
  const total = presentes.reduce((s, p) => s + (p.valor || 0), 0);
  res.json({ total, quantidade: presentes.length, presentes });
});

/* ---- (opcional) Confirmação de presença ---- */
app.post("/api/rsvp", async (req, res) => {
  const { nome, acompanhantes = 0, recado = "" } = req.body || {};
  if (!nome || !String(nome).trim()) {
    return res.status(400).json({ error: "Informe o nome." });
  }
  await registrar("rsvp.jsonl", {
    nome: String(nome).slice(0, 120),
    acompanhantes: Number(acompanhantes) || 0,
    recado: String(recado).slice(0, 500),
  });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 *  Site estático (só o que deve ser público — o .env fica de fora)
 * ------------------------------------------------------------------ */
app.use("/fotos", express.static(path.join(SITE_DIR, "fotos")));
// mídia do hero — .webm (desktop, fundo transparente), .mp4 (fallback), .png (mobile)
for (const arquivo of ["shot_01.webm", "shot_01.mp4", "shot_01.png"]) {
  app.get("/" + arquivo, (_req, res) =>
    res.sendFile(path.join(SITE_DIR, arquivo))
  );
}
app.get(["/", "/index.html"], (_req, res) =>
  res.sendFile(path.join(SITE_DIR, "index.html"))
);

// Aplica as migrações pendentes antes de subir (idempotente).
let mig = { aplicadas: 0, total: 0 };
try {
  mig = await migrate({ log: (m) => console.log(m) });
} catch (err) {
  console.error("\n✖ Falha nas migrações:", err.message);
  console.error("  Confira a DATABASE_URL e se o Postgres está acessível.\n");
  process.exit(1);
}

app.listen(Number(PORT), () => {
  console.log(`\n  Site no ar:   http://localhost:${PORT}`);
  console.log(
    `  Banco:        ${mig.aplicadas ? mig.aplicadas + " migração(ões) aplicada(s) agora" : "atualizado"} (${mig.total} no total)`
  );
  console.log(
    `  AbacatePay:   ${ABACATEPAY_API_KEY ? "chave v2 carregada" : "SEM CHAVE — 'Presentear' vai falhar"}`
  );
  console.log(`  Checkout:     PIX + Cartão (até 12x) · completionUrl ${SITE || "(origin da request)"}`);
  console.log(`  Ambiente:     ${DEV ? "dev (webhook sem assinatura é aceito)" : "produção"}\n`);
});
