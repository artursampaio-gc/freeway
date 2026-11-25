import { GOPRODUCT_SKUS } from "../data/goproduct-skus";
import type { Cell, Grid } from "./xlsx";

export const TABS = {
  pos: "Controle POs",
  pis: "Controle PIs",
  items: "POs por Item",
  pls: "Controle PLs",
} as const;

export interface Issue {
  tab: string;
  row: number;
  message: string;
}

export interface OrderRec {
  process_code: string;
  kind: string;
  description: string | null;
  area: string | null;
  category: string | null;
  buyer: string | null;
  supplier: string | null;
  po_status: string | null;
  production_status: string | null;
  production_status_raw: string | null;
  po_date: string | null;
  prod_start_sheet: string | null;
  prod_end_sheet: string | null;
  leadtime: string | null;
  qty_total: number | null;
  sku_count: number | null;
  pending_delivery: number | null;
  files_url: string | null;
  notes: string | null;
}

export interface ShipmentRec {
  pi_number: string;
  process_code: string;
  seq: number | null;
  status: string;
  status_raw: string | null;
  destination: string | null;
  modal: string | null;
  trader: string | null;
  carrier_line: string | null;
  ref_bl: string | null;
  qty: number | null;
  etd: string | null;
  eta: string | null;
  duimp_at: string | null;
  draft_duimp: string | null;
  canal: string | null;
  sefaz_at: string | null;
  nf: string | null;
  nf_date: string | null;
  delivery_forecast: string | null;
  notes: string | null;
}

export interface OrderItemRec {
  id: string;
  process_code: string;
  item_supplier: string | null;
  sku: string | null;
  sku_key: string | null;
  sku_code: string | null;
  line: string | null;
  qty: number | null;
  shipped_qty: number | null;
  pending_qty: number | null;
}

export interface ShipmentItemRec {
  id: string;
  pi_number: string;
  process_code: string;
  item_supplier: string | null;
  sku: string | null;
  sku_key: string | null;
  sku_code: string | null;
  qty: number | null;
  boxes: number | null;
}

export interface Normalized {
  orders: OrderRec[];
  shipments: ShipmentRec[];
  orderItems: OrderItemRec[];
  shipmentItems: ShipmentItemRec[];
  issues: Issue[];
  tabsFound: string[];
}

const PROCESS_RE = /^(GOC|BBI)\d{5}$/;
const PI_RE = /^((?:GOC|BBI)\d{5})-(\d+)$/;
const ERROR_RE = /^#(N\/D|N\/A|VALOR!|VALUE!|REF!|DIV\/0!|NOME\?|NAME\?|NUM!|NULO!|NULL!|ERRO|ERROR)/i;
const EMPTY_TEXT = new Set(["", "-", "n/a", "na", "#n/d", "sem entrada", "sem data po", "sem valor de carga", "sem info"]);

export function key(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function text(v: Cell): string | null {
  if (v == null || typeof v === "boolean") return null;
  if (typeof v === "number") return String(v);
  const s = v.replace(/\s+/g, " ").trim();
  if (EMPTY_TEXT.has(s.toLowerCase()) || ERROR_RE.test(s)) return null;
  return s;
}

export function num(v: Cell): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = text(v);
  if (!s) return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Serial do Excel/Sheets (dias desde 30/12/1899) ou texto dd/mm/aaaa → AAAA-MM-DD. */
export function date(v: Cell): string | null {
  if (typeof v === "number") {
    if (v < 20000 || v > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = text(v);
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const PRODUCTION: Record<string, string> = {
  "nao iniciado": "nao_iniciado",
  "em producao": "em_producao",
  "parcialmente pronto": "parcial",
  finalizado: "finalizado",
  servico: "servico",
  cancelada: "cancelada",
  cancelado: "cancelada",
};

const PO_STATUS: Record<string, string> = { aberta: "Aberta", finalizada: "Finalizada", cancelada: "Cancelada" };

export function shipmentStatus(raw: string | null): { status: string; destination: string | null } {
  const k = raw ? key(raw) : "";
  if (k === "pronto para embarque") return { status: "pronto", destination: null };
  if (k === "booking") return { status: "booking", destination: null };
  if (k === "em transito") return { status: "transito", destination: null };
  if (k === "desembaraco") return { status: "desembaraco", destination: null };
  if (k.startsWith("entrega agendada")) {
    const dest = k.includes("itpv") ? "ITPV" : k.includes("ext") ? "EXT" : null;
    return { status: "agendada", destination: dest };
  }
  if (k.startsWith("entregue")) return { status: "entregue", destination: null };
  if (k === "on hold") return { status: "on_hold", destination: null };
  return { status: "desconhecido", destination: null };
}

function canal(raw: string | null): string | null {
  if (!raw) return null;
  const k = key(raw);
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/** Localiza colunas pelo nome do cabeçalho, ignorando acentos, caixa e espaços. */
class Header {
  private idx = new Map<string, number>();
  private list: string[] = [];
  constructor(row: Cell[]) {
    row.forEach((h, i) => {
      if (typeof h !== "string") return;
      const k = key(h);
      this.list.push(k);
      if (!this.idx.has(k)) this.idx.set(k, i);
    });
  }
  col(name: string, opts: { prefix?: boolean } = {}): number {
    const k = key(name);
    if (!opts.prefix) return this.idx.get(k) ?? -1;
    for (const [h, i] of this.idx) if (h.startsWith(k)) return i;
    return -1;
  }
}

function getter(header: Header, tab: string, issues: Issue[], required: string[]) {
  for (const name of required) {
    if (header.col(name) < 0) issues.push({ tab, row: 1, message: `Coluna "${name}" não encontrada` });
  }
  return (row: Cell[], name: string, opts?: { prefix?: boolean }): Cell => {
    const i = header.col(name, opts);
    return i >= 0 ? row[i] ?? null : null;
  };
}

export function normalize(tabs: Record<string, Grid>): Normalized {
  const issues: Issue[] = [];
  const out: Normalized = { orders: [], shipments: [], orderItems: [], shipmentItems: [], issues, tabsFound: Object.keys(tabs) };

  for (const name of Object.values(TABS)) {
    if (!tabs[name]) issues.push({ tab: name, row: 0, message: "Aba não encontrada" });
  }

  const pos = tabs[TABS.pos];
  const known = new Set<string>();
  if (pos?.length) {
    const g = getter(new Header(pos[0]), TABS.pos, issues, ["Processo", "Status", "Status Produção", "Supplier"]);
    pos.slice(1).forEach((row, i) => {
      const code = text(g(row, "Processo"));
      if (!code) return;
      if (!PROCESS_RE.test(code)) {
        issues.push({ tab: TABS.pos, row: i + 2, message: `Código de processo inválido: "${code}"` });
        return;
      }
      if (known.has(code)) {
        issues.push({ tab: TABS.pos, row: i + 2, message: `Processo repetido: ${code}` });
        return;
      }
      known.add(code);
      const prodRaw = text(g(row, "Status Produção"));
      const prod = prodRaw ? PRODUCTION[key(prodRaw)] ?? null : null;
      if (prodRaw && !prod) issues.push({ tab: TABS.pos, row: i + 2, message: `Status Produção desconhecido: "${prodRaw}"` });
      const poRaw = text(g(row, "Status"));
      out.orders.push({
        process_code: code,
        kind: code.slice(0, 3),
        description: text(g(row, "Descrição")),
        area: text(g(row, "Área Solicitante")),
        category: text(g(row, "Categoria")),
        buyer: text(g(row, "Buyer")),
        supplier: text(g(row, "Supplier")),
        po_status: poRaw ? PO_STATUS[key(poRaw)] ?? poRaw : null,
        production_status: prod,
        production_status_raw: prodRaw,
        po_date: date(g(row, "Data PO")),
        prod_start_sheet: date(g(row, "Start Production")),
        prod_end_sheet: date(g(row, "End Production")),
        leadtime: text(g(row, "Leadtime")),
        qty_total: num(g(row, "Qtde Itens")),
        sku_count: num(g(row, "Qtde SKUs")),
        pending_delivery: num(g(row, "Pendência de Entrega")),
        files_url: text(g(row, "Pasta Arquivos")),
        notes: text(g(row, "Outras informações")),
      });
    });
  }

  const pis = tabs[TABS.pis];
  const seenPi = new Set<string>();
  if (pis?.length) {
    const g = getter(new Header(pis[0]), TABS.pis, issues, ["Processo", "No da PI", "Status", "ETA Santos", "Liberação Sefaz"]);
    pis.slice(1).forEach((row, i) => {
      const pi = text(g(row, "No da PI"));
      if (!pi) return;
      const m = pi.match(PI_RE);
      if (!m) {
        issues.push({ tab: TABS.pis, row: i + 2, message: `Número de PI inválido: "${pi}"` });
        return;
      }
      if (!known.has(m[1])) {
        issues.push({ tab: TABS.pis, row: i + 2, message: `${pi}: processo ${m[1]} não está em Controle POs` });
        return;
      }
      if (seenPi.has(pi)) {
        issues.push({ tab: TABS.pis, row: i + 2, message: `PI repetida: ${pi}` });
        return;
      }
      seenPi.add(pi);
      const statusRaw = text(g(row, "Status"));
      const st = shipmentStatus(statusRaw);
      if (st.status === "desconhecido" && statusRaw) {
        issues.push({ tab: TABS.pis, row: i + 2, message: `${pi}: status desconhecido "${statusRaw}"` });
      }
      out.shipments.push({
        pi_number: pi,
        process_code: m[1],
        seq: parseInt(m[2], 10),
        status: st.status,
        status_raw: statusRaw,
        destination: st.destination,
        modal: text(g(row, "Modal")),
        trader: text(g(row, "Trader")),
        carrier_line: text(g(row, "Cia.")),
        ref_bl: text(g(row, "Ref Trading / BL")),
        qty: num(g(row, "Quantidade")),
        etd: date(g(row, "ETD China")) ?? date(g(row, "ETD Booking")),
        eta: date(g(row, "ETA Santos")) ?? date(g(row, "ETA Booking")),
        duimp_at: date(g(row, "Registro DI/DUIMP")),
        draft_duimp: text(g(row, "Draft DUIMP")),
        canal: canal(text(g(row, "Canal"))),
        sefaz_at: date(g(row, "Liberação Sefaz")),
        nf: text(g(row, "NF")),
        nf_date: date(g(row, "Data NF")),
        delivery_forecast: date(g(row, "Entrega Gocase")),
        notes: text(g(row, "Observação")),
      });
    });
  }

  const items = tabs[TABS.items];
  if (items?.length) {
    const g = getter(new Header(items[0]), TABS.items, issues, ["Processo", "Item Supplier", "Quantidade"]);
    const occ = new Map<string, number>();
    items.slice(1).forEach((row, i) => {
      const code = text(g(row, "Processo"));
      const item = text(g(row, "Item Supplier"));
      if (!code && !item) return;
      if (!code || !known.has(code)) {
        issues.push({ tab: TABS.items, row: i + 2, message: `Item sem processo válido (${code ?? "vazio"})` });
        return;
      }
      const base = `${code}|${item ?? ""}`;
      const n = (occ.get(base) ?? 0) + 1;
      occ.set(base, n);
      out.orderItems.push({
        id: `${base}|${n}`,
        process_code: code,
        item_supplier: item,
        sku: text(g(row, "SKU único")) ?? text(g(row, "SKU Ajustado", { prefix: true })),
        sku_key: text(g(row, "Chave")),
        sku_code: null,
        line: text(g(row, "Linha")),
        qty: num(g(row, "Quantidade")),
        shipped_qty: num(g(row, "Embarcado")),
        pending_qty: num(g(row, "Pendência de Recebimento")),
      });
    });
  }

  const pls = tabs[TABS.pls];
  if (pls?.length) {
    const g = getter(new Header(pls[0]), TABS.pls, issues, ["No da PL", "Item Supplier", "Quantidade"]);
    const occ = new Map<string, number>();
    pls.slice(1).forEach((row, i) => {
      const pl = text(g(row, "No da PL"));
      if (!pl) return;
      const m = pl.match(PI_RE);
      if (!m || !seenPi.has(pl)) {
        issues.push({ tab: TABS.pls, row: i + 2, message: `Item de PL sem embarque válido (${pl})` });
        return;
      }
      const item = text(g(row, "Item Supplier"));
      const base = `${pl}|${item ?? ""}`;
      const n = (occ.get(base) ?? 0) + 1;
      occ.set(base, n);
      out.shipmentItems.push({
        id: `${base}|${n}`,
        pi_number: pl,
        process_code: m[1],
        item_supplier: item,
        sku: text(g(row, "SKU único")) ?? text(g(row, "SKU Ajustado", { prefix: true })),
        sku_key: text(g(row, "Chave")),
        sku_code: null,
        qty: num(g(row, "Quantidade")),
        boxes: num(g(row, "Caixas")),
      });
    });
  }

  resolveSkuCodes(out);
  return out;
}

const SKU_CODE = /^[A-Z]{2}\d{6}$/;
let goproductIndex: Map<string, string> | null = null;

function goproduct(): Map<string, string> {
  if (!goproductIndex) {
    goproductIndex = new Map();
    for (const [ipn, name] of GOPRODUCT_SKUS) if (!goproductIndex.has(key(name))) goproductIndex.set(key(name), ipn);
  }
  return goproductIndex;
}

/**
 * Código do SKU de cada item: a "Chave" da planilha quando é um código válido;
 * senão o código que o mesmo produto tem em outra linha da planilha; senão o
 * IPN do GoProduct com o mesmo nome.
 */
function resolveSkuCodes(n: Normalized): void {
  const fromSheet = new Map<string, string>();
  for (const i of [...n.orderItems, ...n.shipmentItems]) {
    const k = i.sku_key?.trim();
    if (i.sku && k && SKU_CODE.test(k) && !fromSheet.has(key(i.sku))) fromSheet.set(key(i.sku), k);
  }
  const gp = goproduct();
  for (const i of [...n.orderItems, ...n.shipmentItems]) {
    const k = i.sku_key?.trim();
    i.sku_code = k && SKU_CODE.test(k) ? k : i.sku ? fromSheet.get(key(i.sku)) ?? gp.get(key(i.sku)) ?? null : null;
  }
}
