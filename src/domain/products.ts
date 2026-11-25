import type { DB, Env } from "../env";
import { all, nowIso, run, upsertJson } from "../db/q";
import { driveAuth, exportXlsx } from "../integrations/drive";
import { fetchRanges } from "../sheet/google";
import { hash } from "../sheet/sync";
import { readXlsx, type Grid } from "../sheet/xlsx";

// Planilha "DB-Produtos e Estoque" (time de supply): de-para dos códigos entre
// os sistemas, estoque do WMS por armazém e status de cada produto. Lida com a
// mesma conta de serviço da planilha de importação.
export const PRODUCTS_SHEET_ID = "1M163GaiqGNwzqcBpk4SDhRICopu_jqm3qnc9P6nWmxI";
const TAB_DEPARA = "Depara WMS";
const TAB_WMS = "Estoque WMS";
const TAB_PRODUTOS = "Produtos";

// Sufixos das variações do código no WMS (nacional, bruto, NFC, manual/B2B, QR code, QR + manual).
const WMS_COLS: Record<string, string> = { "WMS": "base", "WMS Nacional": "NA", "WMS Bruto": "BR", "WMS NFC": "NF", "WMS Manual B2B": "MN", "WMS QR Code": "QR", "WMS QR Code + Manual": "QM" };
const BASE = /^([A-Z]{2}\d{6})(NA|BR|NF|MN|QR|QM)?$/;

const text = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/\./g, "").replace(",", ".")) || 0);

/** Índice das colunas pelo cabeçalho (a primeira linha que tiver a coluna `anchor`). */
function header(grid: Grid, anchor: string): { row: number; col: (name: string) => number } {
  const row = grid.findIndex((r) => r.some((c) => text(c) === anchor));
  const names = (grid[row] ?? []).map(text);
  return { row, col: (name) => names.indexOf(name) };
}

/**
 * Lê as 3 abas. A planilha é pesada (milhares de linhas com fórmulas) e a Sheets
 * API chegou a passar de 2 minutos; a exportação .xlsx pelo Drive traz os
 * valores já calculados de uma vez. Se ela falhar, lê aba por aba pela Sheets API.
 */
/** Compara nomes de aba sem ligar para colchetes, espaços, acentos ou maiúsculas ("Depara [WMS]" = "Depara WMS"). */
const tabKey = (s: string) => s.normalize("NFD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

/** Renomeia as abas lidas para os nomes esperados; as outras são descartadas. */
function canonTabs(tabs: Record<string, Grid>): Record<string, Grid> {
  const out: Record<string, Grid> = {};
  for (const want of [TAB_DEPARA, TAB_WMS, TAB_PRODUTOS]) {
    const found = Object.keys(tabs).find((t) => tabKey(t) === tabKey(want));
    if (found) out[want] = tabs[found];
  }
  return out;
}

async function readTabs(env: Env, id: string): Promise<{ tabs: Record<string, Grid>; via: string; found: string[] }> {
  const t0 = Date.now();
  try {
    const xlsx = await exportXlsx(await driveAuth(env), id, 270_000);
    const all = await readXlsx(xlsx);
    return { tabs: canonTabs(all), found: Object.keys(all), via: `drive (${Math.round(xlsx.byteLength / 1024)} KB em ${Math.round((Date.now() - t0) / 1000)} s)` };
  } catch (err) {
    // Estouro de tempo: a Sheets API também não vai responder; não adianta tentar.
    if ((err as Error).name === "TimeoutError" || /timeout/i.test((err as Error).message)) throw new Error(`a planilha não exportou em ${Math.round((Date.now() - t0) / 1000)} s`);
    console.log(`[produtos] exportação pelo Drive falhou, lendo pela Sheets API: ${(err as Error).message}`);
  }
  const tabs: Record<string, Grid> = {};
  for (const r of [`'${TAB_DEPARA}'!A1:AL`, `'${TAB_WMS}'!A1:M`, `'${TAB_PRODUTOS}'!A1:O`]) Object.assign(tabs, await fetchRanges(env, id, [r]));
  return { tabs: canonTabs(tabs), found: Object.keys(tabs), via: "sheets" };
}

export async function refreshProducts(db: DB, env: Env): Promise<Record<string, unknown>> {
  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY) return { skipped: "conta de serviço não configurada" };
  const id = env.PRODUCTS_SHEET_ID || PRODUCTS_SHEET_ID;
  const started = Date.now();
  const { tabs, via, found } = await readTabs(env, id);
  // Sem as abas, o saldo todo seria apagado como "sumiu da planilha": melhor parar com erro claro.
  const missing = [TAB_DEPARA, TAB_WMS].filter((t) => !tabs[t]?.length);
  if (missing.length) throw new Error(`abas não encontradas: ${missing.join(", ")} (a planilha tem: ${found.join(", ") || "nenhuma"})`);

  // De-para: um produto por código base do WMS (ex.: TX222003), com as variações e os outros códigos.
  const dep = tabs[TAB_DEPARA] ?? [];
  const h = header(dep, "SKU Único");
  const products = new Map<string, Record<string, unknown>>();
  const toBase = new Map<string, string>();
  for (const r of dep.slice(h.row + 1)) {
    const base = text(r[h.col("WMS")]).toUpperCase();
    if (!BASE.test(base)) continue;
    const wms: Record<string, string> = {};
    for (const [colName, suffix] of Object.entries(WMS_COLS)) {
      const code = text(r[h.col(colName)]).toUpperCase();
      if (code) {
        wms[suffix] = code;
        toBase.set(code, base);
      }
    }
    const pick = (...names: string[]) => Object.fromEntries(names.map((n) => [n, text(r[h.col(n)])]).filter(([, v]) => v));
    products.set(base, {
      base_code: base,
      sku_unico: text(r[h.col("SKU Único")]) || null,
      categoria: text(r[h.col("Categoria")]) || null,
      linha: text(r[h.col("Linha")]) || null,
      wms: JSON.stringify(wms),
      factory: JSON.stringify(pick("Versão BR", "Versão CH", "FCI 1 (NFC)", "FCI 2 (Manual)", "Slug BR", "Slug CH", "Slug FCI1 (NFC)", "Slug FCI2 (Manual)")),
      webgex: JSON.stringify(pick("Cód. BR", "Cód. CH Itapeva", "Cód. CH Extrema", "Cód. Manual", "Cód. NFC Itapeva", "Cód. NFC Extrema", "Cód. QR Code Itapeva", "Cód. QR Code Extrema")),
      supplier_code: text(r[h.col("Cód. Injetoras")]) || null,
      status: null, origem: null, fornecedor: null, leadtime: null,
    });
  }

  // Produtos: status, nacional/importação, fornecedor e leadtime, pelo nome (SKU Único).
  const prod = tabs[TAB_PRODUTOS] ?? [];
  const hp = header(prod, "Item");
  const byName = new Map([...products.values()].filter((p) => p.sku_unico).map((p) => [String(p.sku_unico).toLowerCase(), p]));
  // A aba tem duas colunas "Categoria": a segunda é Nacional/Importação.
  const catCols = (prod[hp.row] ?? []).map(text).flatMap((n, i) => (n === "Categoria" ? [i] : []));
  for (const r of prod.slice(hp.row + 1)) {
    const p = byName.get(text(r[hp.col("Item")]).toLowerCase());
    if (!p) continue;
    p.status = text(r[hp.col("Status")]) || null;
    p.origem = text(r[catCols[1] ?? -1]) || null;
    p.fornecedor = text(r[hp.col("Fornecedor")]) || null;
    p.leadtime = text(r[hp.col("Leadtime")]) || null;
  }

  // Estoque do WMS: saldo por código e armazém; a legenda ao lado dá o nome de cada armazém.
  const wmsGrid = tabs[TAB_WMS] ?? [];
  const hw = header(wmsGrid, "codigo");
  const stock = new Map<string, Record<string, unknown>>();
  const armazens: Record<string, string> = {};
  const codCol = hw.col("COD");
  const nameCol = codCol >= 0 ? codCol + 1 : -1;
  for (const r of wmsGrid.slice(hw.row + 1)) {
    if (codCol >= 0 && text(r[codCol])) armazens[text(r[codCol])] = text(r[nameCol]);
    const codigo = text(r[hw.col("codigo")]).toUpperCase();
    const armazem = text(r[hw.col("armazem")]).toUpperCase();
    if (!codigo || !armazem || codigo.startsWith("-")) continue;
    const base = toBase.get(codigo) ?? codigo.match(BASE)?.[1] ?? null;
    const key = `${codigo}|${armazem}`;
    const prev = stock.get(key);
    stock.set(key, {
      codigo, armazem, base_code: base,
      saldo_disponivel: num(r[hw.col("saldo_disponivel")]) + (prev ? Number(prev.saldo_disponivel) : 0),
      saldo_total: num(r[hw.col("saldo_total")]) + (prev ? Number(prev.saldo_total) : 0),
      atualizado_em: text(r[hw.col("atualizado_em")]) || null,
    });
  }

  const productRows: Record<string, unknown>[] = [...products.values()].map((p) => ({ ...p, row_hash: hash(JSON.stringify(p)) }));
  const stockRows: Record<string, unknown>[] = [...stock.values()].map((s) => ({ ...s, row_hash: hash(JSON.stringify(s)) }));
  const prevP = new Map((await all<{ base_code: string; row_hash: string }>(db, `SELECT base_code, row_hash FROM product_codes`)).map((r) => [r.base_code, r.row_hash]));
  const prevS = new Map((await all<{ codigo: string; armazem: string; row_hash: string }>(db, `SELECT codigo, armazem, row_hash FROM wms_stock`)).map((r) => [`${r.codigo}|${r.armazem}`, r.row_hash]));
  const changedP = productRows.filter((p) => prevP.get(p.base_code as string) !== p.row_hash);
  const changedS = stockRows.filter((s) => prevS.get(`${s.codigo}|${s.armazem}`) !== s.row_hash);
  await upsertJson(db, "product_codes", ["base_code", "sku_unico", "categoria", "linha", "wms", "factory", "webgex", "supplier_code", "status", "origem", "fornecedor", "leadtime", "row_hash"], ["base_code"], changedP);
  await upsertJson(db, "wms_stock", ["codigo", "armazem", "base_code", "saldo_disponivel", "saldo_total", "atualizado_em", "row_hash"], ["codigo", "armazem"], changedS);
  // Saldo que sumiu da planilha deixa de existir.
  const goneS = [...prevS.keys()].filter((k) => !stock.has(k));
  if (goneS.length) await run(db, `DELETE FROM wms_stock WHERE codigo || '|' || armazem IN (SELECT value FROM json_each(?))`, [JSON.stringify(goneS)]);
  await run(db, `INSERT INTO settings (key, value) VALUES ('wms_armazens', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify({ at: nowIso(), armazens })]);

  const out = { produtos: products.size, saldos: stock.size, armazens: Object.keys(armazens).length, gravados: changedP.length + changedS.length, removidos: goneS.length, via, ms: Date.now() - started };
  console.log(`[produtos] ${JSON.stringify(out)}`);
  return out;
}
