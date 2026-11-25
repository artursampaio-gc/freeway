// Servidor local para ver as telas: serve os arquivos estáticos e manda /api
// para o worker real, com SQLite em memória carregado da planilha .xlsx.
// Uso: node dist/dev-server.mjs <caminho do .xlsx> [porta]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { DB, Env } from "../src/env";
import worker from "../src/index";
import { installFakeAi } from "./fake-ai";
import { installFakeMonday } from "./fake-monday";
import { linkSamples } from "../src/domain/samples";
import type { MondayItem } from "../src/integrations/monday";

function makeDB(): DB {
  const d = new DatabaseSync(":memory:");
  const conv = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v);
  return {
    async query(sql, params) {
      const rows = d.prepare(sql).all(...(params.map(conv) as any[])) as Record<string, any>[];
      return { columns: [], rows: rows.map((r) => ({ ...r })), rowsRead: rows.length };
    },
    async exec(sql, params) {
      const r = d.prepare(sql).run(...(params.map(conv) as any[]));
      return { rowsWritten: Number(r.changes) };
    },
  };
}

const [xlsxPath, portArg] = process.argv.slice(2);
const port = Number(process.env.PORT ?? portArg ?? 8791);
installFakeAi();
installFakeMonday();
// Slack de mentira: acha qualquer e-mail e escreve as mensagens no console.
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host !== "slack.com") return realFetch(input, init);
    const p = new URLSearchParams(String(init?.body));
    if (url.pathname === "/api/users.lookupByEmail") return Response.json({ ok: true, user: { id: `U_${p.get("email")}` } });
    console.log(`[slack local] para ${p.get("channel")}: ${p.get("text")} · ${p.get("blocks")}`);
    return Response.json({ ok: true });
  }) as typeof fetch;
}
const env: Env = { DB: makeDB(), AI_PROXY_TOKEN: "teste", MONDAY_TOKEN: "teste", SLACK_BOT_TOKEN: "teste" };
const USER = "artur.sampaio@gocase.com";

const STATIC: Record<string, [string, string]> = {
  "/": ["web/index.html", "text/html; charset=utf-8"],
  "/index.html": ["web/index.html", "text/html; charset=utf-8"],
  "/style.css": ["web/style.css", "text/css; charset=utf-8"],
  "/app.js": ["dist/app.js", "text/javascript; charset=utf-8"],
  "/logo.svg": ["src/icon/logo.svg", "image/svg+xml"],
  "/ai.svg": ["src/icon/AI.svg", "image/svg+xml"],
  "/favicon.svg": ["web/favicon.svg", "image/svg+xml"],
};

async function call(method: string, path: string, body?: Uint8Array) {
  const res = await worker.fetch(
    new Request(`http://dev12345.localhost${path}`, { method, headers: { "x-godeploy-user-email": USER }, body: body as unknown as BodyInit }),
    env,
  );
  return res;
}

if (xlsxPath) {
  const r = await call("POST", "/api/admin/import-xlsx", new Uint8Array(readFileSync(xlsxPath)));
  console.log("planilha carregada:", r.status);
  for (const code of ["BBI25205", "GOC25201", "BBI25137", "GOC25007"]) await call("POST", `/api/process/${code}/watch`);
  // Duas amostras do Warehouse Samples (uma ligada pela IA, outra para confirmar) no pedido aberto mais recente.
  const sup = (await env.DB.query(`SELECT supplier FROM orders WHERE po_status = 'Aberta' AND supplier IS NOT NULL ORDER BY po_date DESC LIMIT 1`, [])).rows[0].supplier;
  const now = new Date().toISOString();
  const items: MondayItem[] = [
    { id: "s1", name: "FEDEX879152550162 VOYAGE BICOLOR OFF-WHITE BACKPACK", group: "Received 2026", updated_at: now, url: "https://monday.com", values: { Supplier: sup, Approval: "Waiting", "Date Received": "2026-10-28" } },
    { id: "s2", name: "FEDEX877958962680 CUPS MOOVE", group: "Received 2026", updated_at: now, url: null, values: { Supplier: sup } },
  ];
  for (const it of items) {
    await env.DB.exec(`INSERT INTO monday_items (item_id, board_id, name, group_title, updated_at, url, vals, process_codes) VALUES (?, '6758443649', ?, ?, ?, ?, ?, '[]')`, [it.id, it.name, it.group, it.updated_at, it.url, JSON.stringify(it.values)]);
  }
  await linkSamples(env.DB, env, items, new Set((await env.DB.query(`SELECT process_code FROM orders`, [])).rows.map((r) => r.process_code as string)));
  const code = JSON.parse((await env.DB.query(`SELECT process_codes FROM sample_links WHERE item_id = 's1'`, [])).rows[0].process_codes)[0];
  await call("POST", `/api/process/${code}/watch`);
  console.log(`amostras de teste em ${code}`);
  // Um item do Launches 2026 ligado ao BBI25205, para ver as atualizações pendentes para o Monday.
  await env.DB.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('monday_columns', ?)`, [JSON.stringify({ boards: [{ id: "777000", name: "⭐️ Launches 2026*", columns: [
    { id: "status", title: "Launch status", type: "status", labels: ["On track", "At risk", "Delayed", "Launched"] },
    { id: "stage", title: "Current Stage", type: "status", labels: ["Sample", "Production", "Shipping", "Customs", "Launched"] },
    { id: "date4", title: "Production Completion", type: "date" },
  ] }] })]);
  await env.DB.exec(`INSERT INTO monday_items (item_id, board_id, name, url, vals, process_codes, row_hash) VALUES ('7770001', '777000', '🇧🇷 [TÊXTIL] Mochila Voyage', 'https://monday.com', ?, '["BBI25205"]', 'x')`, [
    JSON.stringify({ "Launch status": "On track", "Current Stage": "Production" }),
  ]);
  // Trilha de desenvolvimento: o quadro Launches escolhido, um lançamento sem pedido com tarefas e a waitlist.
  await env.DB.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('monday_boards', ?)`, [JSON.stringify([{ id: "777000", name: "⭐️ Launches 2026*" }])]);
  await env.DB.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('monday_people', ?)`, [JSON.stringify({ at: now, map: { "clara sousa": "clara.sousa@gocase.com" } })]);
  // O que as planilhas de Waitlist/CTR dizem do Tote Mini Pro (links, resultado, votos e um teste de CTR).
  await env.DB.exec(`INSERT OR REPLACE INTO dev_sheet_match (item_id, data, updated_at) VALUES ('7770002', ?, ?)`, [JSON.stringify({
    plan: { produto: "Tote Mini Pro", status: "WAITLIST ATIVA", links: [{ label: "Waitlist", url: "https://example.com/waitlist" }, { label: "Waitlist 2 (LP)", url: "https://example.com/lp" }, { label: "CTR", url: "https://example.com/ctr" }] },
    ctr: null,
    status: null,
    result: { produto: "Tote Mini Pro", dias: 35, investimento: 1681.97, leads: 1377, cliques: 15493, ctr: 0.0626, custo_lead: 1.22, lead_click: 0.0889, preco: 269.9, ultimo_dia: "2026-07-14" },
    votes: { produto: "Tote Mini Pro", total: 1603, cores: [{ cor: "Preto", n: 298, pct: 18.6 }, { cor: "Marrom", n: 229, pct: 14.3 }, { cor: "Açai", n: 215, pct: 13.4 }, { cor: "Vinho", n: 189, pct: 11.8 }] },
    tests: [{ teste: "CTR ADMAKER - MANUAL] TOTE MINI PRO", investimento: 154.1, ctr: 0.0528, cpc: 0.11, cliques: 1407, status: "PAUSED", data: "2026-06-15" }],
  }), now]);
  await env.DB.exec(`INSERT INTO monday_items (item_id, board_id, name, group_title, url, vals, process_codes, row_hash) VALUES ('7770002', '777000', '🇧🇷 [TÊXTIL] Tote Mini Pro', 'March 2027', 'https://monday.com', ?, '[]', 'x')`, [
    JSON.stringify({ People: "Clara Sousa, Paloma Bermudez", "Current Stage": "Stage 2 - Sample Production and Shipping", "Launch status": "At risk", "Sub-stage": "Development", Waitlist: "Feito", Tipo: "Têxtil" }),
  ]);
  const plus = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  const tasks: [string, string, Record<string, string>][] = [
    ["7770002", "Waitlist", { Status: "Pronto" }],
    ["7770002", "Definição de cores", { Status: "Pronto" }],
    ["7770002", "Ficha Técnica", { Status: "Pronto" }],
    ["7770002", "Produção da amostra", { Status: "Em progresso", Owner: "Leticia Gomes", "Data de entrega": `${plus(-10)} - ${plus(3)}` }],
    ["7770002", "Envio da amostra", { Status: "Não iniciado", "Data de entrega": `${plus(4)} - ${plus(14)}` }],
    ["7770002", "Validação da amostra por qualidade", { Status: "Não iniciado", "Data de entrega": `${plus(15)} - ${plus(20)}` }],
    ["7770002", "Pedido de compra", { Status: "Não iniciado", "Data de entrega": `${plus(30)} - ${plus(30)}` }],
    ["7770001", "Definição de cores", { Status: "Pronto" }],
    ["7770001", "Produção da amostra", { Status: "Pronto" }],
  ];
  let pos = 0;
  for (const [parent, name, vals] of tasks) {
    await env.DB.exec(`INSERT INTO monday_subitems (subitem_id, parent_id, board_id, pos, name, vals, updated_at) VALUES (?, ?, '888000', ?, ?, ?, ?)`, [`sub${pos}`, parent, pos++, name, JSON.stringify(vals), now]);
  }
  // Cores como no GoProduct: composta (pantones), textura (miniatura guardada) e lisa; definidas no Tote Mini Pro.
  const colorRows: [number, string, string, string | null, string[], string | null][] = [
    [10, "Azul e Vermelho", "Dark Blue and Red", "#00205c", ["#00205c", "#d60132"], "https://goproduct.gogroupbr.com/media/cor/texturas/Frame_299.png"],
    [69, "Matcha", "Matcha", "#d1d3ce", ["#d1d3ce", "#adc9a1", "#d87695"], null],
    [24, "Mapa Mundi", "World Map", null, [], "https://goproduct.gogroupbr.com/media/cor/texturas/mapa.png"],
  ];
  for (const [pk, pt, en, hex, pantones, textura] of colorRows) {
    await env.DB.exec(`INSERT OR REPLACE INTO goproduct_colors (pk, nome_pt, nome_en, hex, pantones, textura, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [pk, pt, en, hex, JSON.stringify(pantones), textura, now]);
  }
  // Miniatura de textura de exemplo (8×8, xadrez azul e branco), para não depender do GoProduct.
  await env.DB.exec(`INSERT OR REPLACE INTO goproduct_textures (pk, url, content_type, data, fetched_at) VALUES (24, ?, 'image/png', ?, ?)`, [
    "https://goproduct.gogroupbr.com/media/cor/texturas/mapa.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAH0lEQVR4nGP4AAZO7V+d2r8isxlwSmAKQdi4JehgBwDcsJHBRYvNXwAAAABJRU5ErkJggg==",
    now,
  ]);
  await env.DB.exec(`INSERT OR REPLACE INTO step_state (scope, step_key, data) VALUES ('dev:7770002', 'cores', ?)`, [JSON.stringify({ colors: "Azul e Vermelho, Matcha, Mapa Mundi, Preto" })]);
  // O que a Galeria de Lançamentos diz do Tote Mini Pro (fotos de exemplo em SVG, para não depender da Galeria).
  const foto = (c: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="${c}"/><rect x="30" y="38" width="60" height="50" rx="8" fill="#ffffff" opacity=".85"/></svg>`)}`;
  await env.DB.exec(`INSERT OR REPLACE INTO galeria_launches (slug, item_id, via, data, updated_at) VALUES ('tote-mini-pro', '7770002', 'monday', ?, ?)`, [JSON.stringify({
    slug: "tote-mini-pro", nome: "Tote Mini Pro", mes: "jun/2027", tipo: "Novo", categoria: "Têxtil", subcategoria: "Bolsas", status: "Em andamento", teste: "Waitlist", status_teste: "Finalizado",
    preco: 269.9, custo: 48.2, fob: 6.4, margem: 0.62, ctr: 6.26, cpc: 0.11, custo_lead: 1.22, lead_click: 8.89, proj2026: 0, proj2027: 2738939.2, rec_estimada: 2738939.2,
    receita_mes: [{ mes: "jun/2027", valor: 635025 }, { mes: "jul/2027", valor: 717900 }], fotos: [foto("#6b4f3a"), foto("#1f2a44"), foto("#8e2b3a")], comentarios: 3, via: "monday",
  }), now]);
  // Dois itens do BBI25205 como lançamento na planilha de produtos (estrela na lista de itens).
  const skus = (await env.DB.query(`SELECT DISTINCT sku_code FROM order_items WHERE process_code = 'BBI25205' AND sku_code IS NOT NULL LIMIT 2`, [])).rows.map((r) => r.sku_code as string);
  for (const s of skus) await env.DB.exec(`INSERT OR REPLACE INTO product_codes (base_code, status) VALUES (?, 'Lançamento')`, [s]);
  console.log(`lançamentos de teste: ${skus.join(", ")}`);
  // Nota de importação de exemplo (planilha do fiscal) no frete BBI25205.2.
  await env.DB.exec(`INSERT OR REPLACE INTO fiscal_notes (processo, data, pis, via, updated_at) VALUES (?, ?, ?, ?, ?)`, [
    "WMFIMP-26/2084",
    JSON.stringify({
      processo: "WMFIMP-26/2084", key: "WMFIMP-26/2084", empresa: "BB Indústria", duimp: "26BR0002282948-3", status: "🟠 A conferir no painel",
      etapas: ["✅", "✅ 12/11", "⚠️ 10 a conferir", "", "", ""], nf: null, valor: null, falta: "Conferir 10 item(ns) no painel — 10 código a conferir", mudou: "12/11/2026 14:15",
    }),
    JSON.stringify(["BBI25205-2"]),
    "historico",
    new Date().toISOString(),
  ]);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const st = STATIC[url.pathname];
  if (st) {
    res.writeHead(200, { "Content-Type": st[1] });
    res.end(readFileSync(st[0]));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
  const headers: Record<string, string> = { "x-godeploy-user-email": USER };
  if (req.headers["content-type"]) headers["content-type"] = String(req.headers["content-type"]);
  const out = await worker.fetch(
    new Request(`http://dev12345.localhost${url.pathname}${url.search}`, { method: req.method, headers, body: body as unknown as BodyInit }),
    env,
  );
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, () => console.log(`Freeway local em http://localhost:${port}`));
