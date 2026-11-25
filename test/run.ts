// Teste local: roda o worker de verdade contra um SQLite em memória e a
// planilha exportada em .xlsx. Uso: npm test -- <caminho do .xlsx>
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import type { DB, Env } from "../src/env";
import worker from "../src/index";
import { ingestSheet } from "../src/sheet/sync";
import { readXlsx, type Grid } from "../src/sheet/xlsx";
import { TABS } from "../src/sheet/normalize";
import { addDays, todayBR } from "./util";
import { aiCalls, installFakeAi } from "./fake-ai";
import { installFakeMonday, mondayCalls, mondayOverrides, mondayWrites } from "./fake-monday";
import { refreshMonday } from "../src/domain/monday";
import { linkSamples } from "../src/domain/samples";
import type { MondayItem } from "../src/integrations/monday";
import { refreshDocs } from "../src/domain/docs";
import { refreshProducts } from "../src/domain/products";
import { runTool } from "../src/domain/chat-tools";
import { allocate } from "../src/domain/itapeva";
import { gdiCalls, installFakeGdi } from "./fake-gdi";
import { fakeServiceAccountKey, installFakeGoogle } from "./fake-google";

installFakeAi();
installFakeMonday();
installFakeGdi();

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

const xlsxPath = process.argv[2];
if (!xlsxPath) throw new Error("Passe o caminho do .xlsx");
const xlsx = readFileSync(xlsxPath);
const env: Env = { DB: makeDB(), AI_PROXY_TOKEN: "teste", MONDAY_TOKEN: "teste", ITAPEVA_API_KEY: "teste" };
const ME = "artur.sampaio@gocase.com";
const OTHER = "time.filmagem@gocase.com";

async function call(method: string, path: string, opts: { body?: unknown; raw?: Uint8Array; user?: string } = {}) {
  const headers: Record<string, string> = { "x-godeploy-user-email": opts.user ?? ME };
  let body: BodyInit | undefined;
  if (opts.raw) body = opts.raw as unknown as BodyInit;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const res = await worker.fetch(new Request(`https://abc12345.devgogroup.com${path}`, { method, headers, body }), env);
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return data;
}

const order = async (code: string) => (await call("GET", `/api/process/${code}`)).order;
const unitOf = (o: any, display: string) => o.units.find((u: any) => u.display === display);
const stepOf = (u: any, key: string) => u.steps.find((s: any) => s.key === key);

function showUnit(u: any) {
  const tracks = ["operacao", "site", "marketing"].map((t) => u.steps.filter((s: any) => s.track === t).map((s: any) => `${s.short}=${s.status}${s.inherited ? "*" : ""}`).join(" "));
  console.log(`  ${u.display.padEnd(12)} ${u.kind.padEnd(8)} ${String(Math.round(u.total * 100)).padStart(3)}% ${u.health.padEnd(4)} ${u.finalized ? "LANÇADO " : ""}| ${tracks.join(" | ")}`);
}

const t0 = Date.now();
const r1 = await call("POST", "/api/admin/import-xlsx", { raw: new Uint8Array(xlsx) });
console.log(`Importação 1 (${Date.now() - t0} ms):`, JSON.stringify({ ...r1, issues: undefined }));
assert.ok(r1.baseline, "primeira carga deve ser linha de base");
assert.equal(r1.events, 0);
const r2 = await call("POST", "/api/admin/import-xlsx", { raw: new Uint8Array(xlsx) });
assert.ok(r2.skipped, "segunda carga idêntica deve ser pulada");
console.log("Importação 2: pulada (sem mudanças) ✓");

// Código do SKU: Chave da planilha, completado por outras linhas e pelo GoProduct.
const cov = await env.DB.query(
  `SELECT (SELECT COUNT(*) FROM shipment_items) AS si, (SELECT COUNT(*) FROM shipment_items WHERE sku_code IS NULL) AS si_sem,
          (SELECT COUNT(*) FROM order_items) AS oi, (SELECT COUNT(*) FROM order_items WHERE sku_code IS NULL) AS oi_sem`, []);
console.log("Itens sem código de SKU:", JSON.stringify(cov.rows[0]));

// Busca: "Finalizada" na planilha é só a importação; continua na busca até o lançamento.
const search = await call("GET", "/api/search?q=BBI252");
const searchAll = await call("GET", "/api/search?q=BBI252&filtro=todos");
console.log(`Busca BBI252: ${search.results.length} em andamento de ${searchAll.results.length}`);
for (const code of ["BBI25205", "GOC25201", "BBI25137", "GOC25007"]) await call("POST", `/api/process/${code}/watch`);

const home = await call("GET", "/api/home");
console.log(`\nMeus pedidos: ${home.units.length} pedidos (cada frete de um pedido dividido conta como um pedido)`);
for (const u of home.units.slice(0, 6)) showUnit(u);
const b205 = await order("BBI25205");
assert.ok(unitOf(b205, "BBI25205.2"), "frete de pedido dividido vira pedido próprio");
assert.equal(b205.units.length, 23, "sem processo extra de saldo");
assert.ok(b205.units.every((u: any) => u.kind === "embarque" && u.freight_total === 23));
assert.equal(stepOf(unitOf(b205, "BBI25205.2"), "producao").status, "done", "frete já foi produzido");
const b137 = await order("BBI25137");
assert.deepEqual(b137.units.map((u: any) => u.display), ["BBI25137"], "pedido com um frete só não tem .1");
assert.ok(!home.units.some((u: any) => u.display.endsWith(".1") && u.freight_total === 1));
const g201 = await order("GOC25201");
assert.deepEqual(g201.units.map((u: any) => u.display), ["GOC25201.1", "GOC25201.2"]);
console.log(`BBI25205: ${b205.units.length} fretes · BBI25137: ${b137.units[0].display} · GOC25201: ${g201.units.map((u: any) => u.display).join(", ")}`);
const it1 = unitOf(b205, "BBI25205.1").items;
console.log("Itens do BBI25205.1:", it1.map((i: any) => `${i.code ?? "sem código"} ${i.name}`));
assert.ok(it1.every((i: any) => /^[A-Z]{2}\d{6}$/.test(i.code)), "itens do embarque com código");

// Mudanças na planilha → eventos e notificações por embarque
const tabs = await readXlsx(new Uint8Array(xlsx), Object.values(TABS));
const pis: Grid = tabs[TABS.pis];
const h = pis[0].map((x) => String(x ?? "").trim());
const col = (name: string) => h.indexOf(name);
const rowOf = (pi: string) => pis.find((r) => r[col("No da PI")] === pi)!;
const r205 = rowOf("BBI25205-2");
r205[col("ETA Santos")] = Number(r205[col("ETA Santos")]) + 7;
r205[col("Status")] = "Desembaraço";
const r201 = rowOf("GOC25201-1");
r201[col("Liberação Sefaz")] = 46323;
r201[col("Status")] = "Entrega Agendada (ITPV)";
const r137 = rowOf("BBI25137-1");
r137[col("Status")] = "Em Trânsito";
await call("POST", "/api/teams/itapeva/members", { body: { email: "itapeva@gocase.com" } });
const r3 = await ingestSheet(env.DB, tabs, "teste");
console.log(`\nImportação 3: eventos=${r3.events} notificações=${r3.notifications}`);
assert.ok(r3.events >= 4);
const notesIt = await call("GET", "/api/notifications", { user: "itapeva@gocase.com" });
console.log("Notificações Itapeva:", notesIt.notifications.map((n: any) => n.title));
assert.ok(notesIt.notifications.some((n: any) => n.title === "GOC25201.1: desembaraço concluído"));
const myNotes = await call("GET", "/api/notifications");
const n137 = myNotes.notifications.find((n: any) => n.process_code === "BBI25137");
console.log("Aviso de pedido com um frete só:", n137?.title, "|", n137?.body);
assert.equal(n137?.title, "BBI25137: Em trânsito", "sem .1 no aviso");
assert.ok(!n137.body.includes("BBI25137.1"));

// Trilha de marketing (do pedido)
for (const [team, email] of [["filmagem", OTHER], ["ilustracao", "ilustra@gocase.com"], ["marketing", "mkt@gocase.com"], ["importacao", "import@gocase.com"], ["ecommerce", "ecomm@gocase.com"]]) {
  await call("POST", `/api/teams/${team}/members`, { body: { email } });
}
await call("PATCH", "/api/unit/GOC25007/step/amostra", { body: { tracking: "887065866739" } });
await call("PATCH", "/api/unit/GOC25007/step/amostra", { body: { delivered_at: todayBR() } });
await call("PATCH", "/api/unit/GOC25007/step/amostra", { body: { approval: "aprovado" } });
let g7 = await order("GOC25007");
console.log("\nPróximos passos do pedido GOC25007:", g7.units[0].next_steps.map((n: any) => n.label));
assert.ok(g7.units[0].next_steps.some((n: any) => n.action === "notify_ilustracao"));
await call("POST", "/api/unit/GOC25007/action/notify_ilustracao");
await call("POST", "/api/unit/GOC25007/action/filmagem_entregue");
await call("PATCH", "/api/unit/GOC25007/step/filmagem", { body: { due: addDays(todayBR(), 10) }, user: OTHER });
await call("PATCH", "/api/unit/GOC25007/step/filmagem", { body: { link: "https://drive.google.com/videos" }, user: OTHER });
await call("PATCH", "/api/unit/GOC25007/step/producao", { body: { start: addDays(todayBR(), -20), due: addDays(todayBR(), 3) } });
const mkt = await call("GET", "/api/notifications", { user: "mkt@gocase.com" });
assert.ok(mkt.notifications.some((n: any) => n.body?.includes("https://drive.google.com/videos")));
const imp = await call("GET", "/api/notifications", { user: "import@gocase.com" });
assert.ok(imp.notifications.some((n: any) => n.title.includes("produção termina em 3 dias")));
// Filmagem concluída à mão, sem o link dos vídeos: libera o marketing do produto.
await call("PATCH", "/api/unit/BBI25137/step/filmagem", { body: { done_at: todayBR() }, user: OTHER });
const b137f = (await order("BBI25137")).units[0];
assert.equal(stepOf(b137f, "filmagem").status, "done", "filmagem concluída à mão");
assert.equal(stepOf(b137f, "marketing").status, "doing", "marketing começa depois da filmagem");
const mktF = await call("GET", "/api/notifications", { user: "mkt@gocase.com" });
assert.ok(mktF.notifications.some((n: any) => n.title === "BBI25137: filmagem concluída"));
// Documentação do pedido (carton marks, barcodes) dentro da Produção.
let g7d = (await order("GOC25007")).units[0];
assert.ok(g7d.next_steps.some((n: any) => n.action === "docs_prontos"), "produção em andamento cobra a documentação");
await call("POST", "/api/unit/GOC25007/action/docs_prontos", { user: OTHER });
g7d = (await order("GOC25007")).units[0];
const docsS = stepOf(g7d, "documentacao");
assert.ok(docsS.status === "done" && docsS.data.docs_done_at === todayBR(), "documentação marcada (trilha Desenvolvimento)");
assert.ok(!g7d.next_steps.some((n: any) => n.action === "docs_prontos"));
const meDocs = await call("GET", "/api/notifications");
assert.ok(meDocs.notifications.some((n: any) => n.title === "GOC25007: documentação do pedido pronta"));
const b137d = stepOf((await order("BBI25137")).units[0], "documentacao");
assert.ok(b137d.status === "done" && b137d.source === "inferido", "pedido embarcado: documentação dada como feita");
console.log("Filmagem concluída à mão:", stepOf(b137f, "filmagem").detail, "| marketing:", stepOf(b137f, "marketing").detail);

// IA (simulada): nota por embarque e pendência no embarque certo
const ai1 = await call("POST", "/api/process/BBI25205/ia", { body: {} });
assert.equal(ai1.called, 1);
let b = await order("BBI25205");
const withNote = b.units.find((u: any) => u.kind === "embarque" && u.ai_note);
console.log(`\nIA: ${b.ai.resumo} | ${withNote?.display}: ${withNote?.ai_note}`);
const aiStep = b.units.flatMap((u: any) => u.next_steps).find((n: any) => n.ai);
console.log("Pendência da IA:", aiStep && `${aiStep.unit_display}: ${aiStep.label} [${aiStep.team}]`);
assert.ok(aiStep && aiStep.unit_display.includes("."), "pendência da IA vai para o processo do embarque");
assert.ok(aiCalls.length >= 1);

// Trilha Site: marcado no pedido vale para os embarques; o embarque pode ter o seu.
await call("PATCH", "/api/unit/BBI25205/step/mockups", { body: { done_at: todayBR() } });
await call("PATCH", "/api/unit/BBI25205.2/step/lancamento", { body: { due: addDays(todayBR(), 15) } });
b = await order("BBI25205");
const u2 = unitOf(b, "BBI25205.2");
assert.equal(stepOf(u2, "mockups").status, "done");
assert.ok(stepOf(u2, "mockups").inherited, "mockups vem do pedido");
assert.equal(u2.launch_due, addDays(todayBR(), 15));
assert.equal(stepOf(unitOf(b, "BBI25205.3"), "lancamento").status, "todo", "data de lançamento é só do .2");
await call("PATCH", "/api/unit/BBI25205.2/step/cadastro_site", { body: { done_at: todayBR() } });
await call("PATCH", "/api/unit/BBI25205.2/step/cadastro_wms", { body: { done_at: todayBR() } });
await call("PATCH", "/api/unit/BBI25205.2/step/lancamento", { body: { done_at: todayBR() } });
b = await order("BBI25205");
assert.ok(unitOf(b, "BBI25205.2").finalized, "lançado no site finaliza o processo");
assert.ok(!unitOf(b, "BBI25205.3").finalized);
const ecomm = await call("GET", "/api/notifications", { user: "ecomm@gocase.com" });
console.log("Notificações E-commerce:", ecomm.notifications.map((n: any) => n.title));
const mk2 = await call("GET", "/api/notifications", { user: "mkt@gocase.com" });
assert.ok(mk2.notifications.some((n: any) => n.title === "BBI25205.2: lançado no site"));
const stillSearch = await call("GET", "/api/search?q=BBI25205");
assert.equal(stillSearch.results.length, 1, "pedido com embarques não lançados continua em andamento");

// Produção no frete: "Embarcado" só depois que sai; pronto para embarque ou booking ainda não embarcou.
{
  const ready = (await env.DB.query(`SELECT process_code, pi_number, status FROM shipments WHERE status IN ('pronto', 'booking') LIMIT 1`, [])).rows[0];
  assert.ok(ready, "planilha de teste tem frete pronto para embarque ou em booking");
  const ru = (await order(ready.process_code)).units.find((u: any) => u.unit === ready.pi_number);
  assert.match(stepOf(ru, "producao").detail, /^Produção concluída · (Pronto para embarque|Booking)$/, "frete pronto ainda não embarcou");
  const gone = b.units.find((u: any) => u.kind === "embarque" && ["transito", "desembaraco", "agendada", "entregue"].includes(u.shipment.status));
  assert.match(stepOf(gone, "producao").detail, /^Embarcado/, "frete que já saiu aparece como embarcado");
}

// Industrialização item a item no embarque entregue
const deliv = b.units.find((u: any) => u.kind === "embarque" && u.shipment.status === "entregue" && u.items.length);
for (const it of deliv.items) await call("POST", "/api/item-check", { body: { id: it.id, done: true } });
b = await order("BBI25205");
assert.equal(stepOf(unitOf(b, deliv.display), "industrializacao").status, "done");

// Desembaraço só existe no embarque
await assert.rejects(() => call("PATCH", "/api/unit/BBI25205/step/sefaz", { body: { manual_at: todayBR() } }));

console.log("\nBBI25205 por processo:");
for (const u of b.units.slice(0, 5)) showUnit(u);
const g7b = await order("GOC25007");
showUnit(g7b.units[0]);

// Monday: lista todos os quadros (paginado, sem subitens), guarda os escolhidos e não relê a lista à toa.
const mb = await call("GET", "/api/admin/monday/boards");
assert.equal(mb.boards.length, 130, "duas páginas, sem o quadro de subitens");
assert.equal(mb.boards[0].name, "Importação - Controle de Pedidos", "mais recentes primeiro");
const before = mondayCalls.length;
await call("GET", "/api/admin/monday/boards");
assert.equal(mondayCalls.length, before, "lista guardada por um dia");
const ms = await call("PUT", "/api/admin/monday/boards", { body: { ids: ["900001", "900002", "nao-existe"] } });
assert.deepEqual(ms.selected.map((s: any) => s.id), ["900001", "900002"]);
await assert.rejects(() => call("GET", "/api/admin/monday/boards", { user: OTHER }), "só admin escolhe quadros");
console.log(`\nMonday: ${mb.boards.length} quadros, escolhidos: ${ms.selected.map((s: any) => s.name).join(", ")}`);
// Itens dos quadros escolhidos ligados ao pedido pelo código (no nome ou numa coluna); a 2ª leitura não regrava nada.
await refreshMonday(env.DB, env);
const linkedItems = (await env.DB.query(`SELECT name, process_codes, matched_by FROM monday_items WHERE board_id = '900001' ORDER BY item_id`, [])).rows;
assert.deepEqual(linkedItems.map((r) => JSON.parse(r.process_codes)), [["BBI25205"], ["GOC25007"], []]);
assert.deepEqual(linkedItems.map((r) => r.matched_by), ["nome", "coluna Process", null]);
const before2 = (await env.DB.query(`SELECT COUNT(*) AS n FROM monday_items`, [])).rows[0].n;
// 2ª rodada: só as datas de alteração; nenhum item mudou, então nenhum detalhe é buscado.
const callsBefore = mondayCalls.length;
const r2m = await refreshMonday(env.DB, env);
assert.equal(r2m.full, false, "só uma leitura completa por dia");
assert.ok(!mondayCalls.slice(callsBefore).some((q) => q.includes("items(ids") || q.includes("column_values")), "sem detalhes quando nada mudou");
assert.equal((await env.DB.query(`SELECT COUNT(*) AS n FROM monday_items`, [])).rows[0].n, before2);
// Um item alterado no Monday: só ele é buscado com os detalhes.
await env.DB.exec(`UPDATE monday_items SET updated_at = '2026-10-01T00:00:00Z', row_hash = 'antigo' WHERE item_id = '9000012'`, []);
const callsBefore3 = mondayCalls.length;
await refreshMonday(env.DB, env);
const detailCalls = mondayCalls.slice(callsBefore3).filter((q) => q.includes("items(ids"));
assert.equal(detailCalls.length, 1, "um pedido de detalhes, só para o item alterado");
assert.equal((await env.DB.query(`SELECT updated_at FROM monday_items WHERE item_id = '9000012'`, [])).rows[0].updated_at, "2026-10-30T10:00:00Z");

// Atualizações para o Monday: prévia campo a campo e sincronização manual, relendo o Monday antes de escrever.
const metaRow = (await env.DB.query(`SELECT value FROM settings WHERE key = 'monday_columns'`, [])).rows[0];
const meta = JSON.parse(metaRow.value);
meta.boards.push({ id: "777000", name: "⭐️ Launches 2026*", columns: [
  { id: "status", title: "Launch status", type: "status", labels: ["On track", "At risk", "Delayed", "Launched"] },
  { id: "date4", title: "Production Completion", type: "date" },
] });
await env.DB.exec(`UPDATE settings SET value = ? WHERE key = 'monday_columns'`, [JSON.stringify(meta)]);
await env.DB.exec(`INSERT INTO monday_items (item_id, board_id, name, vals, process_codes, row_hash) VALUES ('7770001', '777000', 'Slim Fold - BBI25205', ?, '["BBI25205"]', 'x')`, [JSON.stringify({ "Launch status": "Working on it" })]);
const mPend = await call("GET", "/api/process/BBI25205/monday");
assert.equal(mPend.live, true, "prévia lida ao vivo no Monday");
const ls1 = mPend.updates.find((u: any) => u.column === "Launch status");
assert.ok(ls1 && ls1.from === "Working on it" && ["On track", "At risk", "Delayed", "Launched"].includes(ls1.to), JSON.stringify(mPend));
const impU = mPend.updates.find((u: any) => u.sub === "Importação" && u.column === "Status");
assert.ok(impU && impU.from === "Aguardando" && impU.to === "Em Desenvolvimento", "subelemento Importação: frete ainda a caminho");
const sy = await call("POST", "/api/process/BBI25205/monday/sync", { body: { items: [ls1, impU].map((u: any) => ({ id: u.id, from: u.from })) } });
assert.deepEqual(sy.escritos.sort(), [ls1.id, impU.id].sort());
assert.ok(mondayWrites.some((w) => w.board === "777000" && w.item === "7770001" && JSON.stringify(w.vals) === JSON.stringify({ status: { label: ls1.to } })));
assert.ok(mondayWrites.some((w) => w.board === "888000" && w.item === "8880001" && JSON.stringify(w.vals) === JSON.stringify({ status: { label: "Em Desenvolvimento" } })), "escreve no quadro de subelementos");
const evs = (await call("GET", "/api/process/BBI25205")).events;
assert.ok(evs.some((e: any) => e.type === "monday_sync" && e.message.includes("› Importação")), "fica na linha do tempo");
assert.equal((await env.DB.query(`SELECT COUNT(*) AS n FROM monday_writes`, [])).rows[0].n, 2);
// Valor que mudou no Monday depois da prévia: não sobrescreve.
mondayOverrides.set("7770001", [{ id: "status", text: "Stuck" }]);
const sy2 = await call("POST", "/api/process/BBI25205/monday/sync", { body: { items: [{ id: ls1.id, from: ls1.from }] } });
assert.equal(sy2.escritos.length, 0);
assert.ok(sy2.pulados[0]?.motivo.startsWith("mudou no Monday"), JSON.stringify(sy2));
// X na sugestão: interpretação errada. Some da lista e não é enviada; volta só se a leitura sugerir outra coisa no campo.
{
  const before = (await call("GET", "/api/process/BBI25205/monday")).updates.find((u: any) => u.column === "Launch status");
  assert.ok(before, "há sugestão de Launch status");
  await call("POST", "/api/process/BBI25205/monday/dismiss", { body: { items: [{ id: before.id, to: before.to, why: before.why, label: "Launch status" }] } });
  const after = await call("GET", "/api/process/BBI25205/monday");
  assert.ok(!after.updates.some((u: any) => u.id === before.id) && after.dismissed.some((u: any) => u.id === before.id), "sai da lista e fica nas marcadas como incorretas");
  const sy3 = await call("POST", "/api/process/BBI25205/monday/sync", { body: { items: [{ id: before.id, from: before.from }] } });
  assert.equal(sy3.escritos.length, 0, "marcada como incorreta não é enviada");
  assert.ok((await call("GET", "/api/process/BBI25205")).events.some((e: any) => e.message.startsWith("Sugestão para o Monday marcada como incorreta")), "fica na linha do tempo");
  // A leitura passou a sugerir outra coisa naquele campo (aqui, simulado pela marca antiga): a sugestão volta.
  await env.DB.exec(`UPDATE monday_dismissed SET to_value = 'Outro valor' WHERE update_id = ?`, [before.id]);
  assert.ok((await call("GET", "/api/process/BBI25205/monday")).updates.some((u: any) => u.id === before.id), "sugestão nova aparece de novo");
  assert.equal((await env.DB.query(`SELECT COUNT(*) AS n FROM monday_dismissed`, [])).rows[0].n, 0, "a marca antiga sai");
  // Voltar a sugerir à mão.
  await call("POST", "/api/process/BBI25205/monday/dismiss", { body: { items: [{ id: before.id, to: before.to, why: before.why, label: "Launch status" }] } });
  await call("POST", "/api/process/BBI25205/monday/restore", { body: { ids: [before.id] } });
  assert.ok((await call("GET", "/api/process/BBI25205/monday")).updates.some((u: any) => u.id === before.id), "voltou a ser sugerida");
}
console.log(`Monday sync:${ls1.column} ${ls1.from} → ${ls1.to} · Importação ${impU.from} → ${impU.to} · depois: ${sy2.pulados[0].motivo}`);

// Leitura da IA: lê tudo do pedido (Monday ligado e linha do tempo), não só a planilha; sem mudança, não lê de novo.
await call("POST", "/api/process/BBI25205/ia", { body: { force: true } });
const aiIn = aiCalls[aiCalls.length - 1].user;
assert.ok(aiIn.includes("Quadros do Monday") && aiIn.includes("Slim Fold - BBI25205"), "itens do Monday ligados ao pedido");
assert.ok(aiIn.includes("Linha do tempo"), "linha do tempo do pedido");
const nAi = aiCalls.length;
await call("POST", "/api/process/BBI25205/ia", { body: {} });
assert.equal(aiCalls.length, nAi, "nada mudou: a IA não lê de novo");

// Amostras do Warehouse Samples: a IA liga pelo nome e fornecedor; abaixo de 80% pede confirmação.
const sup = (await env.DB.query(`SELECT supplier FROM orders WHERE po_status = 'Aberta' AND supplier IS NOT NULL ORDER BY po_date DESC LIMIT 1`, [])).rows[0].supplier;
const now = new Date().toISOString();
const sampleItems: MondayItem[] = [
  { id: "s1", name: "FEDEX879152550162 VOYAGE BICOLOR OFF-WHITE BACKPACK", group: "Received 2026", updated_at: now, url: "https://monday.com/x/s1", values: { Supplier: sup, Approval: "Waiting" } },
  { id: "s2", name: "FEDEX877958962680 CUPS MOOVE", group: "Received 2026", updated_at: now, url: null, values: { Supplier: sup } },
];
for (const it of sampleItems) {
  await env.DB.exec(`INSERT INTO monday_items (item_id, board_id, name, group_title, updated_at, url, vals, process_codes) VALUES (?, '6758443649', ?, ?, ?, ?, ?, '[]')`, [it.id, it.name, it.group, it.updated_at, it.url, JSON.stringify(it.values)]);
}
const known = new Set((await env.DB.query(`SELECT process_code FROM orders`, [])).rows.map((r) => r.process_code as string));
const ls = await linkSamples(env.DB, env, sampleItems, known);
assert.equal(ls.auto, 1);
assert.equal(ls.pendente, 1);
const linkOf = async (id: string) => (await env.DB.query(`SELECT * FROM sample_links WHERE item_id = ?`, [id])).rows[0];
const sCode = JSON.parse((await linkOf("s2")).process_codes)[0];
await call("POST", `/api/process/${sCode}/watch`);
let so = await order(sCode);
const pend = so.samples.find((s: any) => s.item_id === "s2");
assert.equal(pend.state, "pendente");
assert.equal(pend.tracking, "FEDEX877958962680");
assert.ok(so.units.flatMap((u: any) => u.next_steps).some((n: any) => n.label.includes("FEDEX877958962680")), "sugestão vira próximo passo");
await call("POST", "/api/sample-link", { body: { item_id: "s2", process_code: sCode, ok: true } });
so = await order(sCode);
assert.equal(so.samples.find((s: any) => s.item_id === "s2").state, "confirmada");
assert.ok(!so.units.flatMap((u: any) => u.next_steps).some((n: any) => n.label.includes("FEDEX877958962680")));
assert.equal((await linkOf("s2")).status, "confirmado");
// Sem mudança no item nem nos candidatos, a IA não é chamada de novo.
const calls0 = aiCalls.length;
await linkSamples(env.DB, env, sampleItems, known);
assert.equal(aiCalls.length, calls0);
// "Não é deste pedido": sai da página e o pedido não volta como candidato.
await call("POST", "/api/sample-link", { body: { item_id: "s1", process_code: JSON.parse((await linkOf("s1")).process_codes)[0], ok: false } });
assert.ok(JSON.parse((await linkOf("s1")).rejected).length === 1);
console.log(`Amostras: ${JSON.stringify(ls)} · ${sCode} confirmada`);

// Documentação do pedido no Drive: a pasta fica em FileMaker / 2026 / <pedido>; a busca geral
// do Drive acha só uma das pastas, então a varredura tem que abrir pasta por pasta.
const n5 = (await env.DB.query(
  `SELECT substr(process_code, 4) AS n FROM orders GROUP BY substr(process_code, 4) HAVING COUNT(*) = 1 AND MAX(process_code) LIKE 'GOC%' LIMIT 1`, [],
)).rows[0].n as string;
installFakeGoogle({ id: "D1", name: "FileMaker" }, [
  { id: "Y26", name: "2026", parent: "D1" },
  { id: "F1", name: "BBI25137 - YNS", parent: "Y26", files: ["PO - BBI25137.pdf", "BARCODES - BBI25137.pdf", "CARTON MARKS - BBI25137.pdf"] },
  { id: "F2", name: `${n5} - SEM PREFIXO`, parent: "Y26", files: ["BARCODES.pdf"] },
  { id: "F3", name: "GOC25201 - OUTRO", parent: "Y26" },
], ["F3"]);
const genv: Env = { ...env, GOOGLE_SA_EMAIL: "freeway@teste.iam.gserviceaccount.com", GOOGLE_SA_PRIVATE_KEY: await fakeServiceAccountKey() };
const dr = await refreshDocs(env.DB, genv);
const folderOf = async (code: string) => (await env.DB.query(`SELECT folder_id FROM order_docs WHERE process_code = ?`, [code])).rows[0]?.folder_id;
assert.equal(await folderOf("BBI25137"), "F1", "pasta dentro de FileMaker / 2026");
assert.equal(await folderOf(`GOC${n5}`), "F2", "nome sem prefixo, número de um pedido só");
assert.equal(await folderOf("GOC25201"), "F3");
const b137docs = stepOf((await order("BBI25137")).units[0], "documentacao");
assert.ok(b137docs.data.docs_done_at && b137docs.data.folder.includes("F1"), "Barcodes + Carton Marks marcam a documentação, com o link da pasta");
assert.ok(!stepOf((await order(`GOC${n5}`)).units[0], "documentacao").data?.docs_done_at, "só Barcodes não basta");
console.log(`Drive: ${JSON.stringify(dr)}`);

// Planilha de produtos e estoque: de-para pelo código do WMS, saldo por armazém e status do produto.
installFakeGoogle({ id: "D1", name: "FileMaker" }, [], [], {
  "Depara WMS": [
    ["são", "DEPARA SUPPLY", "DEPARA SUPPLY", "FACTORY"],
    ["Categoria", "Linha", "SKU Único", "Versão BR", "Slug BR", "Cód. CH Itapeva", "Cód. Injetoras", "WMS", "WMS Nacional", "WMS Bruto", "WMS NFC", "WMS Manual B2B", "WMS QR Code", "WMS QR Code + Manual"],
    ["Têxtil", "Bolsa Moove", "Bolsa Moove Marrom", "", "", "0103842000009", "", "TX221004", "TX221004NA", "TX221004BR", "TX221004NF", "TX221004MN", "TX221004QR", "TX221004QM"],
  ],
  "Estoque WMS": [
    ["empresa_nome", "armazem", "codigo", "empresa", "saldo_disponivel", "saldo_total", "atualizado_em", "", "", "COD", "ARMAZÉM"],
    ["GoCase", "BRE", "TX221004BR", "945775", 1600, 1616, "", "", "", "ETE", "ESTOQUE EXTREMA"],
    ["GoCase", "ETI", "TX221004NF", "945775", "1.200", "1.200", "", "", "", "ETI", "ESTOQUE ITAPEVA"],
    ["GoCase", "ETE", "TX221004", "945775", 300, 323, "", "", "", "BRE", "BUFFER RECEBIMENTO ITAPEVA"],
  ],
  "Produtos": [
    ["Versão BR", "Versão CH", "FCI 1 (NFC)", "FCI 2 (Manual)", "Status", "Item", "Categoria", "Linha", "Classificação", "Categoria", "PM", "Fornecedor", "Leadtime", "Origem"],
    ["", "", "", "", "Ativo", "Bolsa Moove Marrom", "Têxtil", "Bolsa Moove", "TX", "Importação", "", "Yushi", "90", "China"],
  ],
});
const pr = await refreshProducts(env.DB, genv);
assert.deepEqual([pr.produtos, pr.saldos], [1, 3]);
const moove = (await order("BBI25205")).units.flatMap((u: any) => u.items).find((i: any) => i.code === "TX221004");
assert.ok(moove, "item TX221004 no BBI25205");
assert.deepEqual([moove.stock.itapeva, moove.stock.extrema], [2816, 323], "Itapeva soma bruto (BRE) e NFC (ETI); Extrema separado");
assert.equal(moove.product.origem, "Importação");
assert.equal(moove.status.wms.state, "done", "no de-para do WMS: cadastro no WMS feito");
const ew = await runTool(env.DB, genv, "estoque_wms", { busca: "TX221004" }, ME);
assert.ok(ew.includes("TX221004NF") && ew.includes("ESTOQUE ITAPEVA"), ew);
// 2ª leitura igual: nada é regravado.
assert.equal((await refreshProducts(env.DB, genv)).gravados, 0);
// A etapa "Cadastro no WMS" segue os itens: parcial enquanto falta algum, concluída quando todos estão no de-para.
const wmsUnit = async () => (await order("BBI25205")).units.find((u: any) => u.items.some((i: any) => i.code === "TX221004"));
const wu = await wmsUnit();
const wCodes = [...new Set(wu.items.map((i: any) => i.code).filter(Boolean))] as string[];
assert.ok(wu.items.length > 1 && wCodes.length === wu.items.length, "frete com vários itens, todos com código");
assert.equal(stepOf(wu, "cadastro_wms").status, "doing", `parcial: ${stepOf(wu, "cadastro_wms").detail}`);
const extra = wCodes.filter((c) => c !== "TX221004");
await env.DB.exec(`INSERT INTO product_codes (base_code) SELECT value FROM json_each(?)`, [JSON.stringify(extra)]);
const wDone = stepOf(await wmsUnit(), "cadastro_wms");
assert.deepEqual([wDone.status, wDone.detail], ["done", `Os ${wu.items.length} itens cadastrados no WMS`], "todos no de-para: etapa concluída");
await env.DB.exec(`DELETE FROM product_codes WHERE base_code IN (SELECT value FROM json_each(?))`, [JSON.stringify(extra)]);
console.log(`Produtos: ${JSON.stringify(pr)} · TX221004 Itapeva ${moove.stock.itapeva}, Extrema ${moove.stock.extrema}`);

// Site pela base da fábrica (data proxy com o login de quem abre o app): cadastro = slug ativo;
// no ar = cadastro + saldo pronto em Extrema (+ alinhamento de matriz, quando o pedido tem).
{
  const watchedCodes = (await env.DB.query(`SELECT DISTINCT process_code FROM watchers`, [])).rows.map((r: any) => r.process_code as string);
  let fu: any = null;
  let fCode = "";
  for (const c of watchedCodes) {
    const u = (await order(c)).units.find((x: any) =>
      stepOf(x, "chegada").status === "done" && x.items.length > 1 && x.items.every((i: any) => i.code) && stepOf(x, "lancamento").status !== "done");
    if (u) {
      fu = u;
      fCode = c;
      break;
    }
  }
  assert.ok(fu, "frete entregue, com itens com código, para o teste da fábrica");
  const codes = fu.items.map((i: any) => String(i.code).toUpperCase()) as string[];
  const ready = new Map(codes.map((c, k) => [1000 + k, k === 0 ? 0 : 40])); // o 1º item sem saldo em Extrema
  // Site: slug = modelo + "-" + aparelho. O 1º item começa sem estoque no site; a capa do iPhone 18 Pro não tem o modelo configurado.
  const inStock = new Set([...codes.slice(1).map((c) => `slug-${c.toLowerCase()}`), "boldmagsafepreto-iphone17pro", "boldmagsafepreto-iphone18pro"]);
  const devicesOk = new Set([...codes.map((c) => c.toLowerCase()), "iphone17pro"]);
  const bold = [
    { id: 2001, slug: "boldmagsafepreto-iphone17pro", name: "Case Bold Magsafe Preto / iPhone 17 Pro" },
    { id: 2002, slug: "boldmagsafepreto-iphone17pro-nfc", name: "Case Bold Magsafe Preto / iPhone 17 Pro - NFC" },
    { id: 2003, slug: "boldmagsafepreto-iphone18pro", name: "Case Bold Magsafe Preto / iPhone 18 Pro" },
  ].map((m) => ({ ...m, reference: m.name, beepable_code: "", created_at: "2026-11-03T10:00:00", archived: false, deleted_at: null }));
  const proxyCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host !== "proxy.test") return realFetch(input, init);
    proxyCalls.push(url.pathname);
    assert.equal(new Headers(init?.headers).get("Cookie"), "sessao=1", "repassa o cookie de quem abriu o app");
    const list = (col: string) => [...decodeURIComponent(url.searchParams.get(col) ?? "").matchAll(/"((?:[^"\\]|\\.)*)"|(\d+)/g)].map((m) => m[1] ?? m[2]);
    const j = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/factory/public.materials") {
      if (url.searchParams.get("or")?.includes("Case Bold Magsafe Preto")) return j(bold);
      const beeps = list("beepable_code");
      return j(codes.flatMap((c, k) => (beeps.includes(`${c}QR`) ? [{ id: 1000 + k, slug: `slug-${c.toLowerCase()}`, name: c, reference: c, beepable_code: `${c}QR`, created_at: "2026-10-01T10:00:00", archived: false, deleted_at: null }] : [])));
    }
    if (url.pathname === "/factory/public.supplies") {
      assert.equal(url.searchParams.get("inventory_centre_id"), "eq.11", "estoque de Extrema");
      return j(list("suppliable_id").map((id) => ({ suppliable_id: Number(id), total: (ready.get(Number(id)) ?? 0) + 100, ready: ready.get(Number(id)) ?? 0 })));
    }
    if (url.pathname === "/site/public.spree_universal_material_stocks") {
      assert.equal(url.searchParams.get("store_id"), "eq.1", "loja Brasil");
      return j(list("material").map((m) => ({ material: m, in_stock: inStock.has(m), should_lock: false })));
    }
    if (url.pathname === "/site/public.spree_case_types") return j(list("code").filter((c) => c === "slug" || c === "boldmagsafepreto").map((c) => ({ id: c === "slug" ? 1 : 2, code: c })));
    if (url.pathname === "/site/public.spree_devices") return j(list("code").filter((c) => devicesOk.has(c) || c === "iphone18pro").map((c) => ({ id: c === "iphone18pro" ? 99 : 100 + [...devicesOk].indexOf(c), code: c })));
    if (url.pathname === "/site/public.spree_case_devices") {
      // Toda combinação existe, menos Bold Magsafe × iPhone 18 Pro.
      return j(list("case_type_id").flatMap((t) => list("device_id").filter((d) => !(t === "2" && d === "99")).map((d) => ({ case_type_id: Number(t), device_id: Number(d) }))));
    }
    return j([]);
  }) as typeof fetch;
  const penv: Env = { ...env, PROXY_BASE_URL: "https://proxy.test" };
  const { maybeRefreshFactory, splitDevice } = await import("../src/domain/factory");
  // Um item do pedido pode valer para dois aparelhos; a fábrica cadastra um material por aparelho.
  assert.deepEqual(splitDevice("Case Bold Magsafe Açaí - iPhone 17 Pro / 18 Pro"), { product: "Case Bold Magsafe Açaí", devices: ["iphone17pro", "iphone18pro"], labels: ["iPhone 17 Pro", "iPhone 18 Pro"] });
  assert.deepEqual(splitDevice("Case Bold Magsafe Açaí / iPhone 18 Pro - NFC")?.devices, ["iphone18pro"]);
  assert.deepEqual(splitDevice("Case Anti Impacto Slim Standard / Xiaomi Redmi 9s / 9 Pro")?.devices, ["xiaomiredmi9s", "xiaomiredmi9pro"]);
  assert.equal(splitDevice("Garrafa Fresh Marrom 650ml"), null);
  const unitNow = async () => unitOf(await order(fCode), fu.display);

  // Pedido com alinhamento de matriz: saldo em Extrema não basta.
  await call("PATCH", `/api/unit/${fCode}/step/alinhamento`, { body: { enabled: true } });
  const r1 = await maybeRefreshFactory(env.DB, penv, "sessao=1", true);
  assert.ok(r1 && !r1.erro && r1.cadastrados === codes.length && r1.site === "ok", `fábrica lida: ${JSON.stringify(r1)}`);
  let fv = await unitNow();
  assert.equal(stepOf(fv, "cadastro_site").status, "done", `cadastro no site pela fábrica: ${stepOf(fv, "cadastro_site").detail}`);
  assert.ok(fv.items.every((i: any) => i.status.cadastro.state === "done"));
  assert.equal(fv.items[1].status.lancado.state, "doing");
  assert.ok(fv.items[1].status.lancado.detail.includes("alinhamento de matriz"), fv.items[1].status.lancado.detail);
  assert.equal(fv.items[0].status.lancado.detail, "Ainda não está no site: sem estoque no site");
  assert.notEqual(stepOf(fv, "lancamento").status, "done");

  // Alinhamento feito e saldo em todos: no ar, o lançamento é gravado com data e aviso.
  await call("PATCH", `/api/unit/${fCode}/step/alinhamento`, { body: { done_at: todayBR() } });
  ready.set(1000, 5);
  inStock.add(`slug-${codes[0].toLowerCase()}`);
  assert.equal(await maybeRefreshFactory(env.DB, penv, "sessao=1"), null, "dentro dos 30 min não lê de novo");
  const r2 = await maybeRefreshFactory(env.DB, penv, "sessao=1", true);
  assert.ok(r2 && (r2.lancados as number) >= 1, `lançamento gravado: ${JSON.stringify(r2)}`);
  fv = await unitNow();
  assert.ok(fv.items.every((i: any) => i.status.lancado.state === "done"));
  const lan = stepOf(fv, "lancamento");
  assert.deepEqual([lan.status, lan.data.done_at, lan.data.auto_at], ["done", todayBR(), todayBR()]);
  const ev = (await env.DB.query(`SELECT actor FROM events WHERE type = 'lancado' AND process_code = ? ORDER BY id DESC LIMIT 1`, [fCode])).rows[0];
  assert.equal(ev?.actor, "Fábrica (automático)");

  // Reaberto à mão: a fábrica não marca de novo.
  await call("PATCH", `/api/unit/${fu.unit}/step/lancamento`, { body: { done_at: null } });
  await maybeRefreshFactory(env.DB, penv, "sessao=1", true);
  assert.notEqual(stepOf(await unitNow(), "lancamento").status, "done", "quem reabriu é respeitado");

  // Capa que serve em dois aparelhos: o site é conferido aparelho por aparelho, e a versão NFC não conta.
  await env.DB.exec(`INSERT INTO shipment_items (id, pi_number, process_code, sku, sku_code, qty) VALUES ('teste-bold', ?, ?, ?, NULL, 10)`, [fu.unit, fCode, "Case Bold Magsafe Preto - iPhone 17 Pro / 18 Pro"]);
  await maybeRefreshFactory(env.DB, penv, "sessao=1", true);
  const boldItem = (await unitNow()).items.find((i: any) => i.id === "teste-bold");
  assert.equal(boldItem.status.cadastro.state, "done", boldItem.status.cadastro.detail);
  assert.ok(boldItem.status.cadastro.detail.includes("boldmagsafepreto-iphone18pro") && !boldItem.status.cadastro.detail.includes("-nfc"), boldItem.status.cadastro.detail);
  assert.equal(boldItem.status.lancado.state, "doing");
  assert.equal(boldItem.status.lancado.detail, "No site para iPhone 17 Pro · iPhone 18 Pro: modelo × aparelho ainda não configurado no site");
  await env.DB.exec(`DELETE FROM shipment_items WHERE id = 'teste-bold'`, []);
  globalThis.fetch = realFetch;
  console.log(`Fábrica: ${fu.display} · ${JSON.stringify(r2)} · chamadas ${proxyCalls.length}`);

  // GoProduct: catálogo pelo token (link e miniatura pelo IPN = código WMS); a miniatura fica no banco.
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  let imgCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host !== "goproduct.gogroupbr.com") return realFetch(input, init);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Token gp-teste");
    if (url.pathname === "/api/part/") {
      return new Response(JSON.stringify({ count: 2, next: null, results: [
        { pk: 501, IPN: codes[1], name: "Produto teste", thumbnail: "/media/part_images/t.thumbnail.png", image: "/media/part_images/t.png", active: true },
        { pk: 502, IPN: "XX000000", name: "Outro", thumbnail: null, image: null, active: true },
      ] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    imgCalls++;
    return new Response(png, { status: 200, headers: { "Content-Type": "image/png" } });
  }) as typeof fetch;
  const { refreshGoProduct } = await import("../src/domain/goproduct");
  const genvGp: Env = { ...env, GOPRODUCT_TOKEN: "gp-teste" };
  assert.deepEqual((await refreshGoProduct(env.DB, genvGp)).produtos, 2);
  const gi = (await unitNow()).items.find((i: any) => String(i.code).toUpperCase() === codes[1]);
  assert.deepEqual([gi.goproduct, gi.goproduct_img], [501, "/api/goproduct/img/501"]);
  const { goproductThumb } = await import("../src/domain/goproduct");
  const t1 = await goproductThumb(env.DB, genvGp, 501);
  const t2 = await goproductThumb(env.DB, genvGp, 501);
  assert.deepEqual([t1?.type, [...(t2?.bytes ?? [])], imgCalls], ["image/png", [...png], 1], "baixa uma vez e serve do banco");
  globalThis.fetch = realFetch;
}

// Industrialização pelo GDI: as OPs (SKU + "BR") abatem dos itens dos fretes BBI entregues, por ordem de chegada.
const gItems = (await env.DB.query(
  `SELECT i.id, i.sku_code, i.qty, i.pi_number FROM shipment_items i JOIN shipments s ON s.pi_number = i.pi_number
     LEFT JOIN item_checks c ON c.shipment_item_id = i.id
    WHERE i.process_code LIKE 'BBI%' AND s.status = 'entregue' AND i.sku_code IS NOT NULL AND i.qty > 0 AND c.shipment_item_id IS NULL
      AND i.sku_code NOT IN (SELECT sku_code FROM shipment_items WHERE pi_number <> i.pi_number AND sku_code IS NOT NULL)
    LIMIT 2`, [],
)).rows;
assert.equal(gItems.length, 2, "dois itens de frete entregue para o teste");
const opAt = new Date().toISOString();
const gOps = [
  { id: "op1", numero: "OPI-1", item: `${gItems[0].sku_code}BR`, status: "concluido", quantidade: gItems[0].qty, criado_em: opAt, concluido_em: opAt },
  { id: "op2", numero: "OPI-2", item: `${gItems[1].sku_code}BR`, status: "concluido", quantidade: 1, criado_em: opAt, concluido_em: opAt },
  { id: "op3", numero: "OPI-3", item: `${gItems[1].sku_code}BR`, status: "em_producao", quantidade: 2, criado_em: opAt, concluido_em: null },
  { id: "op4", numero: "OP-4", item: `${gItems[1].sku_code}BR`, status: "cancelado", quantidade: 999, criado_em: opAt, concluido_em: null },
];
for (const o of gOps) {
  await env.DB.exec(`INSERT INTO gdi_ordens (id, numero, item, status, quantidade, criado_em, concluido_em) VALUES (?, ?, ?, ?, ?, ?, ?)`, [o.id, o.numero, o.item, o.status, o.quantidade, o.criado_em, o.concluido_em]);
}
// Frete que chegou agora (fretes que chegaram antes do GDI existir ficam de fora).
await env.DB.exec(`UPDATE shipments SET delivered_at = ? WHERE pi_number IN (?, ?)`, [todayBR(), gItems[0].pi_number, gItems[1].pi_number]);
const al = await allocate(env.DB);
const gView = await order((await env.DB.query(`SELECT process_code FROM shipment_items WHERE id = ?`, [gItems[0].id])).rows[0].process_code as string);
const gi = (id: string) => gView.units.flatMap((u: any) => u.items).find((x: any) => x.id === id);
assert.ok(gi(gItems[0].id).done_at && gi(gItems[0].id).done_by === "GDI (Itapeva)", "item com tudo concluído no GDI fica marcado");
assert.deepEqual([gi(gItems[1].id).gdi.done, gi(gItems[1].id).gdi.doing], [1, 2], "parcial: concluído e em OP aberta; cancelada não conta");
// Desmarcado à mão: o GDI não marca de novo.
await call("POST", "/api/item-check", { body: { id: gItems[0].id, done: false } });
await allocate(env.DB);
const recheck = (await env.DB.query(`SELECT 1 FROM item_checks WHERE shipment_item_id = ?`, [gItems[0].id])).rows.length;
assert.equal(recheck, 0, "o Freeway respeita quem desmarcou");
console.log(`GDI: ${JSON.stringify(al)}`);
const gCell = gi(gItems[1].id).status.industrializacao;
assert.equal(gCell.state, "doing", "parcial no GDI vira pizza");
assert.ok(gCell.pct > 0 && gCell.pct < 1);

// Lista de produtos: cadastro marcado item a item; com todos marcados, a etapa do frete fecha sozinha.
const small = (await env.DB.query(
  `SELECT pi_number, process_code FROM shipment_items WHERE removed_at IS NULL GROUP BY pi_number HAVING COUNT(*) BETWEEN 2 AND 4 LIMIT 1`, [],
)).rows[0];
const smallItems = (await env.DB.query(`SELECT id FROM shipment_items WHERE pi_number = ? AND removed_at IS NULL`, [small.pi_number])).rows.map((r) => r.id as string);
await call("POST", "/api/item-mark", { body: { id: smallItems[0], kind: "cadastro", done: true } });
let sv = await order(small.process_code as string);
let su = sv.units.find((u: any) => u.unit === small.pi_number);
assert.equal(su.items.find((i: any) => i.id === smallItems[0]).status.cadastro.state, "done");
assert.ok(su.items.find((i: any) => i.id === smallItems[1]).status.cadastro.state !== "done");
assert.notEqual(stepOf(su, "cadastro_site").status, "done", "ainda falta item");
for (const id of smallItems.slice(1)) await call("POST", "/api/item-mark", { body: { id, kind: "cadastro", done: true } });
sv = await order(small.process_code as string);
su = sv.units.find((u: any) => u.unit === small.pi_number);
assert.equal(stepOf(su, "cadastro_site").status, "done", "todos os itens marcados fecham o cadastro do frete");
await assert.rejects(() => call("POST", "/api/item-mark", { body: { id: smallItems[0], kind: "outra", done: true } }));
console.log(`Itens: ${small.pi_number} cadastro marcado em ${smallItems.length} itens → etapa concluída`);
// FCI é por produto: parcial enquanto falta item, concluída com todos marcados.
await call("POST", "/api/item-mark", { body: { id: smallItems[0], kind: "fci", done: true } });
su = (await order(small.process_code as string)).units.find((u: any) => u.unit === small.pi_number);
assert.equal(su.items.find((i: any) => i.id === smallItems[0]).status.fci.state, "done");
assert.ok(stepOf(su, "fci").status !== "done" && stepOf(su, "fci").detail.startsWith(`1 de ${smallItems.length} itens com FCI`), stepOf(su, "fci").detail);
for (const id of smallItems.slice(1)) await call("POST", "/api/item-mark", { body: { id, kind: "fci", done: true } });
su = (await order(small.process_code as string)).units.find((u: any) => u.unit === small.pi_number);
assert.equal(stepOf(su, "fci").status, "done", "todos os itens com FCI fecham a etapa");

// Aba Perguntar: o pedido citado vai com todos os detalhes; pergunta sobre Itapeva faz a IA consultar o GDI.
const ch = await call("POST", "/api/chat", { body: { messages: [{ role: "user", content: "como está o BBI25205.2?" }] } });
assert.ok(ch.answer.includes("BBI25205"), ch.answer);
const ch2 = await call("POST", "/api/chat", { body: { messages: [{ role: "user", content: "como está o BBI25205.2?" }, { role: "assistant", content: ch.answer }, { role: "user", content: "e o frete 3?" }] } });
assert.ok(ch2.answer.includes("BBI25205"), "o pedido citado antes continua no contexto");
const ch3 = await call("POST", "/api/chat", { body: { messages: [{ role: "user", content: "quanto da bolsa moove já foi industrializado em itapeva?" }] } });
assert.deepEqual(ch3.consultas.map((c: string) => c.split(" ")[0]), ["itapeva_ordens"]);
assert.ok(ch3.answer.includes("OPI-20261030-001") || ch3.answer.includes("2 OPs"), ch3.answer);
assert.ok(gdiCalls.some((c) => c.includes("tipo=OP%2COPI") && c.includes("item=TX221004BR")), "só OP e OPI, filtrado pelo item");
await assert.rejects(() => call("POST", "/api/chat", { body: { messages: [] } }));
console.log(`Perguntar: ${ch3.answer.replace(/\n/g, " | ")}`);

// Slack: avisos novos por mensagem direta, uma vez por pessoa; quem desligou não recebe; o acumulado de antes não sai.
{
  const { deliver } = await import("../src/domain/notify");
  const { sendSlack } = await import("../src/domain/slack");
  const realFetch = globalThis.fetch;
  const posts: { channel: string; text: string; blocks: any[] }[] = [];
  let failPost: string | Record<string, string> | null = null;
  const ids: Record<string, string> = { [ME]: "U_ME", [OTHER]: "U_OTHER" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    // Envio da foto do cartão: o endereço de upload que o Slack devolve.
    if (url.host === "files.slack.com") return new Response("OK");
    if (url.host !== "slack.com") return realFetch(input, init);
    if (url.pathname === "/api/files.getUploadURLExternal") return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/teste", file_id: "F0FOTO" });
    if (url.pathname === "/api/files.completeUploadExternal") return Response.json({ ok: true, files: [{ id: "F0FOTO" }] });
    assert.match(new Headers(init?.headers).get("Authorization") ?? "", /^Bearer xox[bp]-teste$/);
    const p = new URLSearchParams(String(init?.body));
    if (url.pathname === "/api/users.lookupByEmail") {
      const id = ids[p.get("email") ?? ""];
      return Response.json(id ? { ok: true, user: { id } } : { ok: false, error: "users_not_found" });
    }
    if (url.pathname === "/api/chat.postMessage") {
      if (failPost) return Response.json(typeof failPost === "string" ? { ok: false, error: failPost } : { ok: false, ...failPost });
      posts.push({ channel: p.get("channel")!, text: p.get("text")!, blocks: JSON.parse(p.get("blocks")!) });
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  env.SLACK_BOT_TOKEN = "xoxb-teste";
  await env.DB.exec(`UPDATE notification_recipients SET slack_at = 'antes'`, []);
  assert.deepEqual(await sendSlack(env.DB, env), { sent: 0, failed: 0 }, "nada pendente");
  const code = (await env.DB.query(`SELECT process_code FROM watchers WHERE user_email = ? LIMIT 1`, [ME])).rows[0].process_code as string;
  const NOBODY = "fora.do.slack@gocase.com";
  await call("POST", `/api/process/${code}/watch`, { user: OTHER });
  await call("POST", `/api/process/${code}/watch`, { user: NOBODY });
  assert.equal((await call("POST", "/api/slack", { user: OTHER, body: { on: false } })).on, false);
  assert.equal(await deliver(env.DB, [{ nkey: "slack-teste-1", process_code: code, kind: "teste", title: `${code}: <Produção> & cia`, body: "Prazo 10/11." }]), 1);
  const s1 = await sendSlack(env.DB, env);
  assert.equal(s1?.sent, 1, JSON.stringify(s1));
  assert.ok((s1?.failed ?? 0) >= 1, "quem não está no Slack fica marcado sem envio");
  assert.deepEqual(posts.map((p) => p.channel), ["U_ME"], "quem desligou não recebe");
  assert.ok(posts[0].blocks[0].text.text.includes("&lt;Produção&gt; &amp; cia"), posts[0].blocks[0].text.text);
  // Cartão: pedido com o nome (até 80 caracteres), situação e o botão "Abrir no Freeway".
  const btn = posts[0].blocks.find((b: any) => b.type === "actions")?.elements[0];
  assert.deepEqual([btn?.text.text, btn?.url], ["Abrir no Freeway", `https://freeway.devgogroup.com/#/p/${code}`], JSON.stringify(posts[0].blocks));
  const fields = posts[0].blocks.find((b: any) => b.fields)?.fields.map((x: any) => x.text) ?? [];
  assert.ok(fields[0]?.startsWith(`*Pedido*\n${code}`), fields.join(" | "));
  assert.ok((fields[0] ?? "").length <= `*Pedido*\n${code} · `.length + 80, "nome cortado em 80 caracteres");
  assert.ok(fields.some((t: string) => t.startsWith("*Situação*")), "traz a situação do pedido");
  assert.equal(posts[0].blocks[0].accessory?.slack_file?.id, "F0FOTO", "foto do produto enviada ao Slack e usada no cartão");
  assert.equal((await env.DB.query(`SELECT COUNT(*) AS n FROM slack_images`, [])).rows[0].n, 1, "a foto vai ao Slack uma vez só");
  assert.deepEqual(await sendSlack(env.DB, env), { sent: 0, failed: 0 }, "cada pessoa recebe uma vez");
  // Uma alteração no app manda na hora o aviso que ela gerou.
  await deliver(env.DB, [{ nkey: "slack-teste-2", process_code: code, kind: "teste", title: `${code}: segundo aviso` }]);
  await call("POST", "/api/notifications/read", { user: OTHER, body: { ids: [] } });
  assert.equal(posts.length, 2, "saiu junto com a alteração");
  // Token inválido: para sem marcar e manda quando voltar.
  failPost = "invalid_auth";
  await deliver(env.DB, [{ nkey: "slack-teste-3", process_code: code, kind: "teste", title: `${code}: terceiro aviso` }]);
  assert.equal((await sendSlack(env.DB, env))?.stopped, "invalid_auth");
  assert.equal((await call("GET", "/api/slack")).app_error, "token do Slack inválido");
  failPost = null;
  assert.equal((await sendSlack(env.DB, env))?.sent, 1);
  const st = await call("GET", "/api/slack");
  assert.deepEqual([st.configured, st.on, st.app_error, st.sent_7d >= 3], [true, true, null, true]);
  // Mensagem de teste da Configuração.
  await call("POST", "/api/slack/test");
  assert.match(posts.at(-1)?.text ?? "", /^Teste do Freeway/);
  assert.ok(posts.at(-1)?.blocks.some((b: any) => b.type === "actions"), "o teste já vem no formato do cartão");
  await assert.rejects(() => call("POST", "/api/slack/test", { user: NOBODY }), /não foi encontrado no Slack/);
  // Falta de permissão: a tela diz qual falta e o que o token tem; volta a mandar depois de corrigir.
  failPost = { error: "missing_scope", needed: "chat:write", provided: "users:read,users:read.email" };
  await assert.rejects(() => call("POST", "/api/slack/test"), /falta a permissão chat:write no app do Slack \(o token tem: users:read, users:read\.email\)/);
  await deliver(env.DB, [{ nkey: "slack-teste-4", process_code: code, kind: "teste", title: `${code}: quarto aviso` }]);
  const s4 = await sendSlack(env.DB, env);
  assert.deepEqual([s4?.stopped, s4?.needed, s4?.sent], ["missing_scope", "chat:write", 0]);
  assert.match((await call("GET", "/api/slack")).app_error, /falta a permissão chat:write/);
  // Token de usuário (xoxp-) gravado no lugar do token do bot.
  env.SLACK_BOT_TOKEN = "xoxp-teste";
  await assert.rejects(() => call("POST", "/api/slack/test"), /não é o do bot \(começa com xoxp-\)/);
  assert.equal((await call("GET", "/api/slack")).token_kind, "usuario");
  env.SLACK_BOT_TOKEN = "xoxb-teste";
  failPost = null;
  assert.equal((await sendSlack(env.DB, env))?.sent, 1, "o aviso parado sai depois de corrigir");
  assert.equal((await call("GET", "/api/slack")).app_error, null);
  // Com foto: a imagem vai ao lado do título (slack_file); a versão sem foto fica pronta para o caso de o Slack recusar.
  const { slackMessage, cut } = await import("../src/domain/slack");
  const longo = "Garrafa Pro, Copo Life (1100ml, 880ml), Fresh 950ml, Fresh 650ml, Straw/Brush, Hanger Copo Life e mais itens";
  const card = slackMessage({ reason: null, title: "BBI25243.4: nota emitida", body: null, process_code: "BBI25243", pi_number: "BBI25243-4" }, { name: longo, status: "Chegada: entrega agendada", health: "ok", imageId: "F0TESTE" });
  assert.deepEqual(card.blocks[0] && (card.blocks[0] as any).accessory?.slack_file, { id: "F0TESTE" });
  assert.equal((card.noImage[0] as any).accessory, undefined);
  assert.ok((card.blocks[1] as any).fields[0].text.endsWith(cut(longo, 80)) && cut(longo, 80).length <= 80 && cut(longo, 80).endsWith("…"));
  assert.match((card.blocks[1] as any).fields[1].text, /No prazo · Chegada: entrega agendada/);
  console.log(`Slack: ${posts.length} mensagens · ${posts[0].blocks[0].text.text.replace(/\n/g, " | ")}`);
  delete env.SLACK_BOT_TOKEN;
  globalThis.fetch = realFetch;
}

// FedEx: teste das chaves pela Configuração (produção, chave de teste, chave errada); para a FedEx vão só os dígitos.
{
  const realFetch = globalThis.fetch;
  const tracked: string[][] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.host.endsWith("fedex.com")) return realFetch(input, init);
    if (url.pathname === "/oauth/token") {
      const id = new URLSearchParams(String(init?.body)).get("client_id");
      const okHere = url.host === "apis.fedex.com" ? id === "prod" : id === "sandbox";
      return okHere ? Response.json({ access_token: "t" }) : Response.json({ errors: [{ code: "NOT.AUTHORIZED.ERROR" }] }, { status: 401 });
    }
    const nums: string[] = JSON.parse(String(init?.body)).trackingInfo.map((t: any) => t.trackingNumberInfo.trackingNumber);
    tracked.push(nums);
    return Response.json({
      output: {
        completeTrackResults: nums.map((n) => ({
          trackingNumber: n,
          trackResults: [{ latestStatusDetail: { code: "DL", description: "Entregue" }, dateAndTimes: [{ type: "ACTUAL_DELIVERY", dateTime: "2026-11-08T10:00:00" }] }],
        })),
      },
    });
  }) as typeof fetch;
  env.FEDEX_CLIENT_SECRET = "s";
  env.FEDEX_CLIENT_ID = "sandbox";
  assert.match((await call("POST", "/api/admin/fedex/test")).message, /chaves de teste/);
  env.FEDEX_CLIENT_ID = "errada";
  assert.match((await call("POST", "/api/admin/fedex/test")).message, /recusou as chaves/);
  env.FEDEX_CLIENT_ID = " prod ";
  const ft = await call("POST", "/api/admin/fedex/test");
  assert.equal(ft.ok, true, ft.message);
  assert.match(ft.message, /funcionando: rastreio \d{12}/);
  assert.match(tracked.at(-1)![0], /^\d{12,22}$/, "só os dígitos vão para a FedEx");
  await assert.rejects(() => call("POST", "/api/admin/fedex/test", { user: OTHER }), /Só administradores/);
  console.log(`FedEx: ${ft.message}`);
  delete env.FEDEX_CLIENT_ID;
  delete env.FEDEX_CLIENT_SECRET;
  globalThis.fetch = realFetch;
}

// Planilha do fiscal: sem acesso, avisa com o e-mail da conta de serviço; com acesso, lê a aba "Notas de Importação".
{
  const { maybeCheckFiscal } = await import("../src/integrations/fiscal");
  const realFetch = globalThis.fetch;
  let shared = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "fake" });
    if (url.host !== "sheets.googleapis.com") return realFetch(input, init);
    if (!shared) return Response.json({ error: { code: 403 } }, { status: 403 });
    if (!url.pathname.includes("values:batchGet"))
      return Response.json({ properties: { title: "Alterações — WebGex, App FCI e Notas de Importação" }, sheets: [{ properties: { title: "WebGex" } }, { properties: { title: "Notas de Importação" } }] });
    const r = url.searchParams.get("ranges")!;
    assert.ok(r.startsWith("'Notas de Importação'!"), r);
    return Response.json({ valueRanges: [{ range: r, values: [["Notas de Importação — 2 processos"], ["Processo", "Empresa"], ["WMFIMP-26/2057", "BB Indústria"], ["IMP-02/13796", "—"]] }] });
  }) as typeof fetch;
  const f1 = await maybeCheckFiscal(env.DB, genv);
  assert.equal(f1?.ok, false);
  assert.match(f1!.error!, /freeway@teste\.iam\.gserviceaccount\.com ainda não tem acesso/);
  shared = true;
  const f2 = await maybeCheckFiscal(env.DB, genv);
  assert.deepEqual([f2?.ok, f2?.tab, f2?.rows], [true, "Notas de Importação", 2], "sem acesso antes: confere de novo na rodada seguinte");
  assert.equal(await maybeCheckFiscal(env.DB, genv), null, "com acesso, não confere de novo antes de 6 h");
  assert.equal((await call("GET", "/api/admin/status")).fiscal.rows, 2);
  console.log(`Fiscal: ${f2?.summary}`);
  globalThis.fetch = realFetch;
}

// Trilha de desenvolvimento: lançamentos do Launches (Monday) com tarefas, Waitlist/CTR, lista de SKUs,
// observadores automáticos e a cobrança do prazo de produção depois da documentação.
{
  const { run: sql } = await import("../src/db/q");
  const { parseSkuGrid, taskStep, bestMatch, syncLaunchTasks, saveSheetMatches, trackingRows, matchTests } = await import("../src/domain/dev");
  {
    // Cores escritas (PO em inglês, app em português) ganham o hexadecimal do GoProduct.
    const { buildPalette, paletteHex } = await import("../src/domain/colors");
    const pal = buildPalette([{ nome_pt: "Verde Água", nome_en: "Aqua Green", hex: "#7FD1C0" }]);
    assert.equal(paletteHex("Sky Blue", pal), "#b6cfde");
    assert.equal(paletteHex("PETAL PINK", pal), "#f5dadf");
    assert.equal(paletteHex("Azul Ceu", pal), "#b6cfde", "sem acento também casa");
    assert.equal(paletteHex("SKY BLUE 544C", pal), "#b6cfde", "nome da cor dentro do texto");
    assert.equal(paletteHex("Light Grey", pal), "#a1a3a5", "grey = gray (Cinza)");
    assert.equal(paletteHex("Navy", pal), null);
    assert.equal(paletteHex("Aqua Green", pal), "#7fd1c0", "cor lida do GoProduct vale também");
  }
  const { businessDays, runTimeRules } = await import("../src/domain/rules");
  const LB = "9392961557";
  await sql(env.DB, `INSERT INTO settings (key, value) VALUES ('monday_boards', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify([{ id: LB, name: "⭐️ Launches 2026*" }])]);
  await sql(env.DB, `INSERT INTO settings (key, value) VALUES ('monday_people', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify({ at: new Date().toISOString(), map: { "ana teste": "ana@gocase.com" } })]);
  await call("POST", "/api/process", { body: { process_code: "BBI29001", description: "Mochila City", supplier: "YNS" } });
  const item = (id: string, name: string, vals: Record<string, string>, codes: string[], group = "March 2027") =>
    sql(env.DB, `INSERT INTO monday_items (item_id, board_id, name, group_title, updated_at, url, vals, process_codes, matched_by, row_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'x')`,
      [id, LB, name, group, "2026-11-10T10:00:00Z", `https://monday/${id}`, JSON.stringify(vals), JSON.stringify(codes), codes.length ? "coluna Process" : null]);
  await item("501", "🇧🇷 [TÊXTIL] Tote Mini Pro", { People: "Ana Teste, bruna.mendes@gocase.com", "Current Stage": "Stage 2 - Sample Production and Shipping", "Launch status": "At risk", Waitlist: "Feito" }, []);
  await item("502", "🇧🇷 [TÊXTIL] Mochila City", { People: "Ana Teste", "Current Stage": "Stage 1 - Creation", "Launch status": "On track", Waitlist: "CTR", Process: "BBI29001" }, ["BBI29001"]);
  await item("503", "Case cancelada", { "Launch status": "Canceled" }, [], "Cancelados");
  // Planilhas de Waitlist/CTR: links por coluna, resultado da waitlist, votos de cor e testes de CTR.
  const lc = (text: string, link: string | null = null) => ({ text, link });
  const plan = trackingRows([
    [lc("Imagem"), lc("PRODUTO"), lc("WAITLIST"), lc("WAITLIST 2"), lc("CTR"), lc("Status"), lc("Landing Page")],
    [lc(""), lc("Tote Mini Pro"), lc(""), lc("Link - LP", "https://lp/tote"), lc("Link", "https://ctr/tote"), lc("WAITLITS PAUSADA"), lc("")],
  ]);
  assert.deepEqual(plan[0].links, [{ label: "Waitlist 2 (LP)", url: "https://lp/tote" }, { label: "CTR", url: "https://ctr/tote" }]);
  assert.equal(matchTests("Mochila City", [{ teste: "CTR ADMAKER - MANUAL] MOCHILA CITY" }, { teste: "[MOCHILA CITY BICOLOR]" }, { teste: "MOCHILA DAILY" }]).length, 2);
  assert.equal(matchTests("Tote", [{ teste: "TOTE SUNDAY" }]).length, 0, "uma palavra só não casa teste");
  const sm = await saveSheetMatches(env.DB, {
    plan,
    ctr: trackingRows([[lc("PRODUTO"), lc("CTR (teste A)"), lc("Status")], [lc("Mochila City"), lc("Teste A", "https://ctr/a"), lc("")]]),
    status: [],
    result: [{ produto: "Tote Mini Pro", dias: 35, investimento: 1681.97, leads: 1377, cliques: 15493, ctr: 0.0626, custo_lead: 1.22, lead_click: 0.0889, preco: 269.9, ultimo_dia: "2026-07-14" }],
    votes: [{ produto: "Tote Mini Pro", total: 1603, cores: [{ cor: "Preto", n: 298, pct: 18.6 }, { cor: "Marrom", n: 229, pct: 14.3 }] }],
    tests: [{ teste: "CTR ADMAKER - MANUAL] MOCHILA CITY", investimento: 6.2, ctr: 0.0986, cpc: 0.09, cliques: 68, status: "ACTIVE", data: "2026-09-23" }],
  });
  assert.equal(sm.casados, 2, "Tote Mini Pro e Mochila City casados com as planilhas");
  const task = (id: string, parent: string, pos: number, name: string, vals: Record<string, string>) =>
    sql(env.DB, `INSERT INTO monday_subitems (subitem_id, parent_id, board_id, pos, name, vals, updated_at) VALUES (?, ?, 'S1', ?, ?, ?, ?)`, [id, parent, pos, name, JSON.stringify(vals), new Date().toISOString()]);
  const future = addDays(todayBR(), 20);
  await task("t1", "501", 0, "Waitlist", { Status: "Pronto" });
  await task("t2", "501", 1, "Definição de cores", { Status: "Pronto", "Data de conclusão": "2026-10-01" });
  await task("t3", "501", 2, "Produção da amostra", { Status: "Em progresso", Owner: "Leticia", "Data de entrega": `2026-10-01 - ${future}` });
  await task("t4", "501", 3, "Validação da amostra por qualidade", { Status: "Não iniciado" });
  await task("t5", "501", 4, "Produção em massa", { Status: "Não iniciado" });
  await task("t6", "501", 5, "Ficha Técnica", { Status: "Em progresso" });
  await task("t7", "502", 0, "Definição de cores", { Status: "Atrasado", Owner: "Ana Teste" });

  assert.deepEqual(
    ["Waitlist", "Definição de cores", "Produção da amostra4", "Ajuste da amostra e transporte", "Envio da amostra", "Validação da amostra ajustada", "Aprovação de Amostras", "Pedido de compra", "Amostras para marketing", "Transporte Itapeva", "Mockup", "Projeção de vendas"].map(taskStep),
    ["waitlist", "cores", "amostra_fab", "amostra_fab", "amostra", "amostra_validacao", "amostra_validacao", "documentacao", null, null, null, null],
    "cada tarefa do Monday vai para a etapa certa (ou fica fora)",
  );
  assert.equal(bestMatch("🇧🇷 [TÊXTIL] Tote Daily - Novas Cores", [{ produto: "Tote Daily" }, { produto: "Tote Daily - novas cores" }])?.produto, "Tote Daily - novas cores");
  assert.equal(bestMatch("Mochila City", [{ produto: "Mochila City Bicolor Grande" }]), null, "nome parecido demais não casa");
  assert.equal(businessDays("2026-11-06", "2026-11-10"), 2, "sexta → terça: 2 dias úteis");

  // Lançamentos abertos: o sem pedido aparece, o cancelado não.
  const dl = await call("GET", "/api/dev");
  const p1 = dl.projects.find((p: any) => p.info.item_id === "501");
  assert.ok(p1 && !dl.projects.some((p: any) => p.info.item_id === "503"), "cancelado fica de fora");
  const st = (p: any, k: string) => p.steps.find((s: any) => s.key === k);
  assert.deepEqual(p1.info.emails.sort(), ["ana@gocase.com", "bruna.mendes@gocase.com"], "nome do People vira e-mail");
  assert.equal(p1.info.name, "[TÊXTIL] Tote Mini Pro");
  assert.equal(st(p1, "ctr").status, "done", "waitlist feita: CTR já passou");
  assert.equal(st(p1, "waitlist").status, "done");
  assert.match(st(p1, "waitlist").detail, /35 dias · 1\.377 leads · custo\/lead R\$ 1,22/);
  assert.equal(st(p1, "waitlist").data.links[0].url, "https://lp/tote", "link da landing page no cartão da waitlist");
  assert.equal(st(p1, "waitlist").data.result.leads, 1377);
  assert.equal(st(p1, "ctr").data.links[0].url, "https://ctr/tote", "link do CTR vai para o cartão de CTR");
  assert.equal(st(p1, "cores").status, "done");
  assert.equal(st(p1, "amostra_fab").status, "doing");
  assert.match(st(p1, "amostra_fab").detail, /Produção da amostra: Em progresso · Leticia/);
  assert.equal(st(p1, "documentacao").status, "todo");
  assert.equal(p1.info.other_tasks.map((t: any) => t.name).join(), "Ficha Técnica", "tarefa sem etapa aparece à parte; produção em massa fica fora");
  assert.equal(p1.next_task.name, "Produção da amostra");

  // Lista de SKUs temporária: à mão e por lista (cabeçalho reconhecido sem IA).
  await call("POST", "/api/skus", { body: { scope: "dev:501", code: "tx221004", name: "Bolsa Moove Marrom", qty: 100 } });
  const imp = await call("POST", "/api/skus/import", { body: { scope: "dev:501", text: "SKU;Nome;Qtd\nGF702082;Base grande;1130\nGF700121;Base pequena;750\n" } });
  assert.deepEqual([imp.rows, imp.via], [2, "tabela"]);
  let d1 = (await call("GET", "/api/dev/501")).project;
  assert.equal(d1.skus.source, "lista");
  assert.deepEqual(d1.skus.rows.map((r: any) => r.code), ["TX221004", "GF702082", "GF700121"]);
  assert.match(st(d1, "goproduct").detail, /de 3 SKUs no GoProduct · faltam/);
  const again = await call("POST", "/api/skus/import", { body: { scope: "dev:501", text: "Código\tQuantidade\nGF702113\t910" } });
  assert.equal(again.rows, 1);
  d1 = (await call("GET", "/api/dev/501")).project;
  assert.deepEqual(d1.skus.rows.map((r: any) => r.code), ["TX221004", "GF702113"], "lista nova substitui a lista anterior; o que foi à mão fica");
  await call("DELETE", `/api/skus/${d1.skus.rows[1].id}`);
  await assert.rejects(call("POST", "/api/skus", { body: { scope: "xyz", code: "A" } }), /Lista inválida/);

  // PO do FileMaker: a tabela de itens começa na linha "INTERNAL ITEM NUMBER".
  const poGrid: Grid = [
    [null, "Purchase Order", "GO COMÉRCIO"], [], [null, "Origin", "Incoterms"],
    [null, "INTERNAL ITEM NUMBER", "COLOR", "PHOTO/IMAGE", "DESCRIPTION", "SPECIFICATIONS", "QTY", "UNIT", "Unit price", "Total Price (USD)"],
    [null, "GF702082", "Candy Pink Rosa Candy ██████ PANTONE", null, "SILICONE BASE LARGE - CANDY PINK", "For 950ml", 1130, "pc", 0.38, 429.4],
    [null, "GF700121", "Sky Blue Azul Céu ███ PANTONE", null, "SILICONE BASE SMALL - SKY BLUE", "For 350ml", 750, "pc", 0.28, 210],
    [null, null, null, null, null, null, 1880, null, "TOTAL", 639.4], [], [null, "COUNTRY OF ORIGIN: CHINA"],
  ];
  assert.deepEqual(parseSkuGrid(poGrid), [
    { code: "GF702082", name: "SILICONE BASE LARGE - CANDY PINK · Candy Pink Rosa Candy", qty: 1130 },
    { code: "GF700121", name: "SILICONE BASE SMALL - SKY BLUE · Sky Blue Azul Céu", qty: 750 },
  ]);

  // Pedido ligado pela coluna Process: a trilha aparece no pedido, com a lista temporária do lançamento.
  await call("POST", "/api/skus", { body: { scope: "dev:502", code: "TX9999", qty: 10 } });
  let o9 = await order("BBI29001");
  assert.equal(o9.dev.item_id, "502");
  assert.equal(o9.skus.rows[0].code, "TX9999");
  const u9 = o9.units[0];
  assert.equal(stepOf(u9, "ctr").status, "doing", "Waitlist = CTR no Monday: em teste");
  assert.match(stepOf(u9, "ctr").detail, /Teste A · melhor teste: CTR 9,9%/, "teste da planilha de CTR casado pelo nome");
  assert.equal(stepOf(u9, "ctr").data.tests[0].cliques, 68);
  assert.equal(stepOf(u9, "ctr").data.links[0].url, "https://ctr/a");
  // Itens: sem itens na planilha, os SKUs da lista aparecem na lista de itens e podem ser marcados.
  const listItem = u9.items.find((i: any) => i.code === "TX9999");
  assert.ok(listItem && listItem.origin && listItem.id.startsWith("sku:"), "SKU da lista entra na lista de itens");
  await sql(env.DB, `INSERT OR REPLACE INTO goproduct_parts (pk, ipn, name, thumbnail, active, updated_at) VALUES (99101, 'TX9999', 'Item da lista', '/media/part_images/TX9999.thumbnail.png', 1, ?)`, [new Date().toISOString()]);
  const listItemGp = (await order("BBI29001")).units[0].items.find((i: any) => i.code === "TX9999");
  assert.equal(listItemGp.goproduct, 99101, "item da lista de SKUs com link do GoProduct");
  assert.equal(listItemGp.goproduct_img, "/api/goproduct/img/99101", "item da lista de SKUs com a foto do GoProduct");
  await call("POST", "/api/item-mark", { body: { id: listItem.id, kind: "cadastro", done: true } });
  assert.equal((await order("BBI29001")).units[0].items.find((i: any) => i.code === "TX9999").status.cadastro.state, "done");
  assert.equal(stepOf(u9, "cores").status, "late", "tarefa atrasada no Monday");
  assert.equal(stepOf(u9, "documentacao").status, "todo");
  assert.ok(!u9.steps.some((s: any) => s.key === "amostra" && s.track !== "desenvolvimento"), "amostra saiu de Operação");
  // Observadores automáticos: as pessoas do lançamento, uma vez só.
  const { autoWatch } = await import("../src/domain/dev");
  assert.equal(await autoWatch(env.DB), 1, "Ana passa a observar o BBI29001");
  o9 = await order("BBI29001");
  assert.ok(o9.watchers.includes("ana@gocase.com"));
  await call("DELETE", "/api/process/BBI29001/watch", { user: "ana@gocase.com" });
  assert.equal(await autoWatch(env.DB), 0, "quem deixou de observar não volta");
  // Documentação enviada sem prazo de produção: cobra quem observa; com prazo, para de cobrar.
  await call("POST", "/api/process/BBI29001/watch");
  await call("POST", "/api/unit/BBI29001/action/docs_prontos");
  await runTimeRules(env.DB, ["BBI29001"]);
  const nPrazo = (await call("GET", "/api/notifications")).notifications.filter((n: any) => n.title === "BBI29001: informe o prazo de conclusão da produção");
  assert.equal(nPrazo.length, 1, "aviso para informar o prazo");
  o9 = await order("BBI29001");
  assert.ok(o9.units[0].next_steps.some((n: any) => n.label === "Informar o prazo de conclusão da produção"));
  assert.ok(o9.steps.find((s: any) => s.key === "ctr").status === "done", "documentação enviada: o que vem antes dela já aconteceu");
  await call("PATCH", "/api/unit/BBI29001/step/producao", { body: { due: addDays(todayBR(), 30) } });
  o9 = await order("BBI29001");
  assert.ok(!o9.units[0].next_steps.some((n: any) => n.label === "Informar o prazo de conclusão da produção"));
  // Cartões editáveis: rodar a waitlist de novo, concluir, cores (digitadas ou do GoProduct).
  await call("POST", "/api/skus", { body: { scope: "dev:501", code: "ZZ000001", name: "Tote Mini Pro Lilás", qty: 5 } });
  await sql(env.DB, `INSERT INTO goproduct_parts (pk, ipn, name, active, cor, cor_hex, updated_at) VALUES (99001, 'ZZ000001', 'Tote Mini Pro Lilás', 1, 'Lilás', '#c8a2c8', ?)`, [new Date().toISOString()]);
  let d5 = (await call("GET", "/api/dev/501")).project;
  assert.deepEqual(st(d5, "cores").data.color_list.map((c: any) => [c.name, c.hex, c.source]), [["Lilás", "#c8a2c8", "GoProduct"]], "cor pelo cadastro no GoProduct");
  await call("PATCH", "/api/dev-step/dev:501/waitlist", { body: { rerun_at: todayBR(), note: "trocar o criativo" } });
  d5 = (await call("GET", "/api/dev/501")).project;
  assert.equal(st(d5, "waitlist").status, "doing", "rodar de novo reabre mesmo com o Monday dizendo pronto");
  assert.match(st(d5, "waitlist").detail, /2ª rodada desde .* · trocar o criativo/);
  await call("PATCH", "/api/dev-step/dev:501/waitlist", { body: { done_at: todayBR() } });
  d5 = (await call("GET", "/api/dev/501")).project;
  assert.equal(st(d5, "waitlist").status, "done");
  await call("PATCH", "/api/dev-step/dev:501/cores", { body: { colors: "Preto, Off White" } });
  d5 = (await call("GET", "/api/dev/501")).project;
  assert.deepEqual(st(d5, "cores").data.color_list.map((c: any) => [c.name, c.hex]), [["Preto", "#000000"], ["Off White", "#d7c4b6"]], "cores digitadas valem primeiro, com o hexadecimal do GoProduct");
  await assert.rejects(call("PATCH", "/api/dev-step/dev:501/goproduct", { body: { done_at: todayBR() } }), /não editável/);
  await call("PATCH", "/api/dev-step/dev:502/ctr", { body: { na: true } });
  const o9b = await order("BBI29001");
  assert.equal(o9b.steps.find((x: any) => x.key === "ctr").status, "na");
  const evDev = (await call("GET", "/api/process/BBI29001")).events.filter((e: any) => e.type === "desenvolvimento");
  assert.ok(evDev.some((e: any) => e.message === "CTR marcado como não se aplica"), "marcação no lançamento vai para a linha do tempo do pedido");
  // Observar um desenvolvimento: aparece em Minhas Observações e avisa quando uma etapa muda.
  {
    const { notifyDevChanges } = await import("../src/domain/dev");
    const OUTRA = "outra.pessoa@gocase.com";
    await call("POST", "/api/dev/501/watch");
    assert.equal((await call("GET", "/api/dev/501")).project.watching, true);
    assert.ok((await call("GET", "/api/dev")).projects.find((p: any) => p.info.item_id === "501").watching);
    assert.ok((await call("GET", "/api/home")).devs.some((p: any) => p.info.item_id === "501"), "desenvolvimento observado em Minhas Observações");
    assert.equal((await call("GET", "/api/home", { user: OUTRA })).devs.length, 0, "só para quem observa");
    // Outra pessoa conclui a fabricação da amostra no app: quem observa recebe o aviso na hora.
    await call("PATCH", "/api/dev-step/dev:501/amostra_fab", { body: { done_at: todayBR() }, user: OUTRA });
    const nDev = (await call("GET", "/api/notifications")).notifications.find((n: any) => n.process_code === "dev:501");
    assert.ok(nDev && /etapa Fabricação de amostra concluída/.test(nDev.title), "aviso da etapa concluída para quem observa");
    assert.equal((await notifyDevChanges(env.DB)).avisos, 0, "a rotina não repete o aviso");
    // Quem marcou não observa e não recebe; e quem observa e marca não recebe o próprio aviso.
    assert.ok(!(await call("GET", "/api/notifications", { user: OUTRA })).notifications.some((n: any) => n.process_code === "dev:501"));
    await call("POST", "/api/dev/501/watch", { user: OUTRA });
    await call("PATCH", "/api/dev-step/dev:501/amostra_fab", { body: { done_at: null }, user: OUTRA });
    await call("PATCH", "/api/dev-step/dev:501/amostra_fab", { body: { done_at: todayBR() }, user: OUTRA });
    assert.ok(!(await call("GET", "/api/notifications", { user: OUTRA })).notifications.some((n: any) => n.process_code === "dev:501"), "sem aviso para quem marcou");
    // Quem observa o lançamento passa a observar o pedido ligado; aí ele aparece como pedido, não repetido.
    await call("POST", "/api/dev/502/watch", { user: OUTRA });
    assert.ok((await call("GET", "/api/home", { user: OUTRA })).devs.some((p: any) => p.info.item_id === "502"));
    await autoWatch(env.DB);
    assert.equal((await env.DB.query(`SELECT 1 FROM watchers WHERE process_code = 'BBI29001' AND user_email = ?`, [OUTRA])).rows.length, 1, "observa o pedido ligado ao lançamento");
    assert.ok(!(await call("GET", "/api/home", { user: OUTRA })).devs.some((p: any) => p.info.item_id === "502"), "lançamento com pedido observado não se repete");
    await call("DELETE", "/api/dev/501/watch");
    assert.ok(!(await call("GET", "/api/home")).devs.some((p: any) => p.info.item_id === "501"), "deixou de observar");
    await assert.rejects(call("POST", "/api/dev/999999/watch"), /não encontrado/);
  }
  // Sem token do Monday, a leitura das tarefas não roda.
  assert.ok((await syncLaunchTasks(env.DB, { ...env, MONDAY_TOKEN: "" } as Env)).skipped);
  console.log(`Desenvolvimento: ${dl.projects.length} lançamentos abertos · ${p1.info.name}: ${p1.current} · ${o9.process_code}: ${o9.dev.name}`);
}

// Título dado no app: no pedido todo, num frete de pedido dividido, e volta ao da planilha quando apagado.
{
  await call("PUT", "/api/unit/BBI25205/title", { body: { title: "  Copos   térmicos 40oz  " } });
  let t = await order("BBI25205");
  assert.equal(t.title, "Copos térmicos 40oz");
  assert.ok(t.units.every((u: any) => u.title === "Copos térmicos 40oz"), "título do pedido vale para os fretes");
  await call("PUT", "/api/unit/BBI25205.3/title", { body: { title: "Copos — reposição" } });
  t = await order("BBI25205");
  assert.equal(unitOf(t, "BBI25205.3").title, "Copos — reposição");
  assert.equal(unitOf(t, "BBI25205.2").title, "Copos térmicos 40oz", "título do .3 vale só para ele");
  const found = await call("GET", "/api/search?q=reposi&filtro=todos");
  assert.ok(found.results.some((r: any) => r.process_code === "BBI25205" && r.title === "Copos térmicos 40oz"), "a busca acha pelo título");
  await call("PUT", "/api/unit/BBI25205/title", { body: { title: "x".repeat(300) } });
  assert.equal((await order("BBI25205")).title.length, 120);
  await call("PUT", "/api/unit/BBI25205/title", { body: { title: "" } });
  await call("PUT", "/api/unit/BBI25205.3/title", { body: { title: "   " } });
  t = await order("BBI25205");
  assert.ok(t.title === null && t.units.every((u: any) => u.title === null), "vazio volta ao título da planilha");
  const tev = (await call("GET", "/api/process/BBI25205")).events.filter((e: any) => e.type === "titulo");
  assert.ok(tev.some((e: any) => e.message === 'BBI25205.3: título alterado para "Copos — reposição"' && e.pi_number === "BBI25205-3"));
  assert.ok(tev.some((e: any) => e.message === "BBI25205: título voltou ao da planilha" && e.pi_number === null));
  // Pedido com um frete só: o título fica no pedido, pelo código ou pela PI.
  const single = (await order("BBI25137")).units[0];
  await call("PUT", `/api/unit/${single.unit}/title`, { body: { title: "Bolsas Voyage" } });
  const s1 = await order("BBI25137");
  assert.deepEqual([s1.title, s1.units[0].title], ["Bolsas Voyage", "Bolsas Voyage"]);
  console.log(`Título: ${single.display} → ${s1.units[0].title} (${tev.length} eventos no BBI25205)`);
}

// Cancelar / on hold no app: some de Em andamento, sem próximos passos; avisa quem segue (menos quem marcou); reativar volta.
{
  const code = "GOC25201";
  const before = await order(code);
  assert.notEqual(before.po_status, "Cancelada");
  assert.equal(before.hold, null);
  await call("POST", `/api/process/${code}/watch`, { user: OTHER });
  await call("PUT", `/api/process/${code}/hold`, { body: { state: "on_hold", note: "  Aguardando aprovação do orçamento " } });
  let h = await order(code);
  assert.deepEqual([h.hold.state, h.hold.note, h.hold.by], ["on_hold", "Aguardando aprovação do orçamento", ME]);
  const open = h.units.filter((u: any) => !u.finalized);
  assert.ok(open.length > 0 && open.every((u: any) => u.situacao === "on_hold" && u.next_steps.length === 0 && !u.next_milestone && u.current === "On hold: Aguardando aprovação do orçamento"), "on hold para o pedido todo");
  const home = await call("GET", "/api/home");
  assert.ok(home.units.filter((u: any) => u.process_code === code && !u.finalized).every((u: any) => u.situacao === "on_hold"));
  assert.ok(!home.myNextSteps.some((n: any) => n.unit_display.startsWith(code)), "on hold não tem próximos passos");
  assert.ok((await call("GET", "/api/notifications", { user: OTHER })).notifications.some((n: any) => n.process_code === code && n.title === `${code} está on hold`), "quem segue é avisado");
  assert.ok(!(await call("GET", "/api/notifications")).notifications.some((n: any) => n.title === `${code} está on hold`), "quem marcou não é avisado");
  assert.equal((await call("PUT", `/api/process/${code}/hold`, { body: { state: "on_hold", note: "Aguardando aprovação do orçamento" } })).changed, false, "repetir não muda nada");
  await call("PUT", `/api/process/${code}/hold`, { body: { state: "cancelado", note: "Fornecedor desistiu" } });
  h = await order(code);
  assert.ok(h.units.every((u: any) => u.situacao === "cancelado" && u.current === "Cancelado: Fornecedor desistiu"), "cancelado vale para todos os fretes");
  assert.ok(!(await call("GET", `/api/search?q=${code}`)).results.some((r: any) => r.process_code === code), "cancelado sai da busca em andamento");
  assert.equal((await call("GET", `/api/search?q=${code}&filtro=todos`)).results.find((r: any) => r.process_code === code)?.hold, "cancelado");
  await call("PUT", `/api/process/${code}/hold`, { body: { state: null } });
  h = await order(code);
  assert.equal(h.hold, null);
  assert.deepEqual(h.units.map((u: any) => u.situacao), before.units.map((u: any) => u.situacao), "reativar volta ao que era");
  assert.deepEqual(h.units.map((u: any) => u.next_steps.length), before.units.map((u: any) => u.next_steps.length));
  const ev = (await call("GET", `/api/process/${code}`)).events.filter((e: any) => e.type === "situacao").map((e: any) => e.message);
  assert.deepEqual(ev, ["Pedido reativado no Freeway (estava cancelado)", "Pedido cancelado no Freeway: Fornecedor desistiu", "Pedido colocado on hold no Freeway: Aguardando aprovação do orçamento"]);
  await assert.rejects(call("PUT", "/api/process/GOC99999/hold", { body: { state: "on_hold" } }), /não encontrado/);
  await call("DELETE", `/api/process/${code}/watch`, { user: OTHER });
  console.log(`Situação: ${code} on hold → cancelado → reativado (${ev.length} eventos) · situações: ${before.units.map((u: any) => `${u.display}=${u.situacao}/${u.current_step}`).join(", ")}`);
}

// Notas de Importação: código do processo e os apelidos do Histórico (WMF e I-MAR têm dois códigos).
{
  const { fiscalKey, parseFiscalHistory } = await import("../src/integrations/fiscal");
  assert.equal(fiscalKey("IMPORTACAO WMFIMP-26-1775.xlsx"), "WMFIMP-26/1775");
  assert.equal(fiscalKey("IMP-02/13796"), "IMP-02/13796");
  assert.equal(fiscalKey("IMFOR00424/26"), "IMFOR00424/26");
  const h = parseFiscalHistory([
    ["09/11/2026", "—", "Grokbot", "", "WebGex", "Nota fiscal de importação", "Lançou no WebGex a NF de importação nº 13533 (CMI26000823 / I-MAR-2268-26, BB IMPDMP, 19 itens, R$ 1.653.360,37)", "", "", "", "", "", "ID WebGex 17988458 • DUIMP 26BR0002215288-2 • https://x"],
    ["09/11/2026", "—", "Grokbot", "", "WebGex", "Nota fiscal de importação", "Lançou no WebGex a NF de importação nº 8241137 (IMFOR00424/26, GO IMPD, 1 itens, R$ 60.026,86)", "", "", "", "", "", "ID WebGex 18029952 • DUIMP 26BR0002080934-5"],
    ["06/11/2026", "14:39", "Claude", "", "App FCI", "Acesso", "Liberou acesso"],
  ]);
  assert.deepEqual(h, [
    { refs: ["CMI26000823", "I-MAR-2268-26"], nf: "13533", duimp: "26BR0002215288-2" },
    { refs: ["IMFOR00424/26"], nf: "8241137", duimp: "26BR0002080934-5" },
  ]);
  // Nota ligada a um frete aparece nele, com a situação e as 6 etapas.
  const note = {
    processo: "IMP-02/13796", empresa: null, duimp: "26BR0001559621-5", status: "⛔ Bloqueada no painel",
    etapas: ["✅", "✅ 20/10", "⛔ 1 bloqueia", "—", "", ""], nf: null, valor: "1653360.37", falta: "Corrigir 1 item(ns) que bloqueiam, no painel", mudou: "46333.41111", key: "IMP-02/13796",
  };
  await env.DB.query(`INSERT INTO fiscal_notes (processo, data, pis, via, updated_at) VALUES (?, ?, ?, ?, ?)`, ["IMP-02/13796", JSON.stringify(note), JSON.stringify(["BBI25205-2"]), "ref", "2026-11-12T19:00:00Z"]);
  const fo = await order("BBI25205");
  const fn = unitOf(fo, "BBI25205.2").fiscal;
  assert.equal(fn.length, 1);
  assert.deepEqual([fn[0].state, fn[0].status, fn[0].valor, fn[0].mudou], ["blocked", "Bloqueada no painel", "R$ 1.653.360,37", "07/11/2026 09:52"]);
  assert.deepEqual(fn[0].etapas.map((e: any) => e.mark), ["done", "done", "blocked", "todo", "todo", "todo"]);
  assert.equal(fn[0].etapas[2].value, "1 bloqueia");
  assert.equal(unitOf(fo, "BBI25205.3").fiscal.length, 0, "só no frete ligado");
  await env.DB.query(`DELETE FROM fiscal_notes`, []);
  // Avisos: a primeira vez só guarda; depois avisa quando trava (bloqueada/erro) ou é emitida, uma vez.
  {
    const { notifyFiscalChanges, fiscalNoteView } = await import("../src/integrations/fiscal");
    const at = (status: string, extra: Record<string, unknown> = {}) => [{ view: fiscalNoteView(JSON.stringify({ ...note, status, ...extra }), "ref", null), pis: ["BBI25205-2"] }];
    const mine = async () => (await call("GET", "/api/notifications")).notifications.filter((n: any) => /nota de importação/.test(n.title)).map((n: any) => n.title);
    assert.equal(await notifyFiscalChanges(env.DB, at("🟠 A conferir no painel")), 0, "primeira vez só guarda");
    assert.equal(await notifyFiscalChanges(env.DB, at("⛔ Bloqueada no painel")), 1, "travou: avisa");
    assert.equal(await notifyFiscalChanges(env.DB, at("⛔ Bloqueada no painel")), 0, "não repete");
    assert.equal(await notifyFiscalChanges(env.DB, at("⏳ Na fila do Grokbot")), 0, "andando não avisa");
    assert.equal(await notifyFiscalChanges(env.DB, at("✅ Emitida", { nf: "13533" })), 1, "emitida: avisa");
    const titles = await mine();
    assert.ok(titles.includes("BBI25205.2: nota de importação bloqueada") && titles.includes("BBI25205.2: nota de importação emitida"), titles.join(" | "));
    await env.DB.query(`DELETE FROM fiscal_seen`, []);
  }
  console.log("Fiscal: código, Histórico, cartão da nota e avisos ok");
}

// Agenda: datas dos fretes, prazos das etapas abertas e tarefas dos desenvolvimentos, sem repetir.
{
  const cal = await call("GET", "/api/agenda?from=2020-01-01&to=2030-12-31");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(cal.today), "agenda traz o dia de hoje");
  assert.ok(cal.events.length > 0, "agenda tem eventos");
  assert.equal(new Set(cal.events.map((e: any) => e.id)).size, cal.events.length, "sem eventos repetidos");
  assert.ok(cal.events.every((e: any) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.href && e.unit && ["logistica", "prazo", "tarefa"].includes(e.group)), "todo evento tem dia, link e tipo");
  const sorted = cal.events.map((e: any) => e.date);
  assert.deepEqual(sorted, [...sorted].sort(), "em ordem de data");
  const groups = new Set(cal.events.map((e: any) => e.group));
  assert.ok(groups.has("logistica"), "tem datas de frete");
  const etd = cal.events.find((e: any) => e.key === "etd");
  assert.ok(etd && etd.label === "Embarque (ETD)" && ["done", "todo", "risk"].includes(etd.state), JSON.stringify(etd));
  const month = await call("GET", "/api/agenda");
  assert.ok(month.events.every((e: any) => e.date.slice(0, 7) === month.today.slice(0, 7)), "sem datas, só o mês de hoje");
  const nov = await call("GET", "/api/agenda?from=2026-11-01&to=2026-11-30");
  assert.ok(nov.events.every((e: any) => e.date >= "2026-11-01" && e.date <= "2026-11-30") && nov.events.length < cal.events.length, "só o período pedido");
  console.log(`Agenda: ${cal.events.length} eventos (${[...groups].join(", ")}) ok`);
}

// Galeria: lançamentos abertos pelo mês de lançamento do Monday.
{
  const { launchMonth } = await import("../src/domain/launches");
  assert.equal(launchMonth("March 2027"), "2027-03");
  assert.equal(launchMonth("Novembro 2026"), "2026-11");
  assert.equal(launchMonth("nov/2026"), "2026-11");
  assert.equal(launchMonth("Março/27"), "2027-03");
  assert.equal(launchMonth("11/2026"), "2026-11");
  assert.equal(launchMonth("Backlog"), null);
  assert.equal(launchMonth(null), null);
  const cal = await call("GET", "/api/lancamentos");
  assert.ok(/^\d{4}-\d{2}$/.test(cal.month) && cal.cards.length > 0, "galeria traz lançamentos");
  const tote = cal.cards.find((c: any) => c.month === "2027-03");
  assert.ok(tote && tote.steps.every((s: any) => s.track === "desenvolvimento"), "lançamento sem pedido: só a linha de desenvolvimento");
  const withOrder = cal.cards.find((c: any) => c.process_codes.length);
  if (withOrder) assert.ok(withOrder.steps.some((s: any) => s.track === "operacao"), "com pedido: traz as linhas do pedido");
  console.log(`Galeria de lançamentos: ${cal.cards.length} lançamentos ok`);
}

// Cores como no GoProduct: composta (pantones) fracionada, textura servida pelo Freeway, lisa.
{
  const { buildPalette, paletteSwatch } = await import("../src/domain/colors");
  const pal = buildPalette([
    { pk: 10, nome_pt: "Azul e Vermelho", nome_en: "Dark Blue and Red", hex: "#00205C", pantones: JSON.stringify(["#00205c", "#d60132"]), textura: "https://goproduct.gogroupbr.com/media/cor/texturas/x.png" },
    { pk: 24, nome_pt: "Mapa Mundi", nome_en: "World Map", hex: null, pantones: "[]", textura: "https://goproduct.gogroupbr.com/media/cor/texturas/mapa.png" },
  ]);
  assert.deepEqual(paletteSwatch("Azul e Vermelho", pal)?.hexes, ["#00205c", "#d60132"], "cor composta traz os dois pantones");
  assert.equal(paletteSwatch("dark blue and red", pal)?.hex, "#00205c", "pelo nome em inglês também");
  assert.equal(paletteSwatch("Mapa Mundi", pal)?.tex, "/api/goproduct/cor/24/textura", "textura pela rota do Freeway");
  assert.equal(paletteSwatch("Preto", pal)?.hex, "#000000", "cor lisa da lista padrão");
  await env.DB.query(`INSERT OR REPLACE INTO goproduct_colors (pk, nome_pt, nome_en, hex, pantones, textura, updated_at) VALUES (24, 'Mapa Mundi', 'World Map', NULL, '[]', 'https://goproduct.gogroupbr.com/media/cor/texturas/mapa.png', '2026-11-18')`, []);
  await env.DB.query(`INSERT OR REPLACE INTO goproduct_textures (pk, url, content_type, data, fetched_at) VALUES (24, 'x', 'image/png', 'iVBORw0KGgo=', '2026-11-18')`, []);
  const get = (pk: number) => worker.fetch(new Request(`https://abc12345.devgogroup.com/api/goproduct/cor/${pk}/textura`, { headers: { "x-godeploy-user-email": ME } }), env);
  const tex = await get(24);
  assert.equal(tex.status, 200, "rota da textura responde");
  assert.equal(tex.headers.get("Content-Type"), "image/png");
  assert.equal((await get(999)).status, 404, "cor sem textura: 404");
  console.log("Cores do GoProduct: composta, textura e lisa ok");
}

// Galeria de Lançamentos: fotos e números lidos da Galeria, ligados ao item do Monday.
{
  const { galeriaInfo } = await import("../src/domain/galeria");
  const g = galeriaInfo({
    nome: "Tote Mini Pro", mes: "mar/2027", tipo: "Novo", categoria: "Têxtil", statusLancamento: "Em andamento", preco: 269.9, custo: "45,50", margem: 0.62, ctr: 6.31,
    revenuePerMonth: { "mar/2027": 635025, "abr/2027": null }, _slug: "tote-mini-pro", _commentCount: 2,
    _media: [{ id: "1brSoFyRyOZyg2oKsnspVMBGI", type: "image", mimeType: "image/png", src: "/api/image/1brSoFyRyOZyg2oKsnspVMBGI?v=178" }, { id: "../x", type: "image", src: "" }],
  }, "monday");
  assert.deepEqual(g.fotos, ["/api/galeria/img/1brSoFyRyOZyg2oKsnspVMBGI?v=178"], "só fotos com id válido, pela rota do Freeway");
  assert.equal(g.custo, 45.5, "número em formato brasileiro");
  assert.equal(g.preco, 269.9);
  assert.deepEqual(g.receita_mes, [{ mes: "mar/2027", valor: 635025 }], "só os meses com receita");
  await env.DB.query(`INSERT OR REPLACE INTO galeria_launches (slug, item_id, via, data, updated_at) VALUES ('tote-mini-pro', '501', 'monday', ?, '2026-11-18')`, [JSON.stringify(g)]);
  const dev = await call("GET", "/api/dev/501");
  assert.equal(dev.project.galeria?.preco, 269.9, "a página do desenvolvimento traz a Galeria");
  const gal = await call("GET", "/api/lancamentos");
  assert.equal(gal.cards.find((c: any) => c.item_id === "501")?.img, g.fotos[0], "na aba Galeria, a foto da Galeria vem primeiro");
  const img = await worker.fetch(new Request("https://abc12345.devgogroup.com/api/galeria/img/naoexiste123", { headers: { "x-godeploy-user-email": ME } }), env);
  assert.equal(img.status, 404, "imagem que a Galeria não lista não é buscada");
  console.log("Galeria de Lançamentos: fotos, números e ligação ao Monday ok");
}

const cronAi = await worker.fetch(new Request("https://abc12345.devgogroup.com/cron/ia", { method: "POST" }), env);
assert.equal(cronAi.status, 403, "rota de cron sem assinatura é recusada");
const me = await call("GET", "/api/me");
console.log(`\n/api/me: admin=${me.isAdmin} não lidas=${me.unread}`);
console.log("\nTudo certo ✓");
