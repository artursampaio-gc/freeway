// Rótulos e formatos usados tanto no servidor quanto na tela.

export const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  pronto: "Pronto para embarque",
  booking: "Booking",
  transito: "Em trânsito",
  desembaraco: "Desembaraço",
  agendada: "Entrega agendada",
  entregue: "Entregue",
  on_hold: "On hold",
  desconhecido: "Status desconhecido",
};

export const PRODUCTION_STATUS_LABEL: Record<string, string> = {
  nao_iniciado: "Não iniciado",
  em_producao: "Em produção",
  parcial: "Parcialmente pronto",
  finalizado: "Finalizado",
  servico: "Serviço",
  cancelada: "Cancelada",
};

export const DESTINATION_LABEL: Record<string, string> = { EXT: "Extrema", ITPV: "Itapeva" };

/**
 * O "Status" da planilha é o da importação, não o do processo: o processo só
 * termina quando o produto é lançado no site (marcado no Freeway).
 */
/** Situação do pedido em Seguindo (filtro e cartões). */
export const SITUACAO_LABEL: Record<string, string> = { andamento: "Em andamento", on_hold: "On hold", cancelado: "Cancelado", lancado: "Lançado" };

export const IMPORT_STATUS_LABEL: Record<string, string> = {
  Aberta: "Importação em andamento",
  Finalizada: "Importação finalizada",
  Cancelada: "Cancelado",
};

/** BBI25205.2 → BBI25205-2 (aceita os dois formatos). */
export function piFromDisplay(s: string): string {
  return s.replace(/\.(\d+)$/, "-$1");
}

export const APPROVAL_LABEL: Record<string, string> = {
  aprovado: "Aprovada",
  aprovado_restricao: "Aprovada com restrição",
  reprovado: "Reprovada",
};

/** BBI25205-2 → BBI25205.2 */
/** Local de um armazém do WMS pelo nome (ou pela última letra do código: I = Itapeva, E = Extrema, L = Linhares). */
export function placeOf(code: string, names: Record<string, string>): "Itapeva" | "Extrema" | "Linhares" | "Outro" {
  const n = (names[code] ?? "").toUpperCase();
  if (n.includes("ITAPEVA")) return "Itapeva";
  if (n.includes("EXTREMA")) return "Extrema";
  if (n.includes("LINHARES")) return "Linhares";
  const last = code.slice(-1);
  return last === "I" ? "Itapeva" : last === "E" ? "Extrema" : last === "L" ? "Linhares" : "Outro";
}

/** Chave de um item na base da fábrica: o código WMS (TX221004) ou, sem código, o nome. */
export function itemKey(code: string | null | undefined, name: string | null | undefined): string | null {
  if (code && code.trim()) return code.trim().toUpperCase();
  if (name && name.trim()) return `nome:${name.trim().toLowerCase()}`;
  return null;
}

/** Slugs do produto preenchidos na planilha de produtos (colunas Slug BR, CH, NFC e Manual). */
export function slugsOf(factoryJson: string | null | undefined): string[] {
  if (!factoryJson) return [];
  const f = JSON.parse(factoryJson) as Record<string, string>;
  return [f["Slug BR"], f["Slug CH"], f["Slug FCI1 (NFC)"], f["Slug FCI2 (Manual)"]].filter((s): s is string => !!s && !!s.trim()).map((s) => s.trim());
}

export function displayPi(pi: string): string {
  return pi.replace(/-(\d+)$/, ".$1");
}

/** 2026-11-04 → 04/11/2026 (ou 04/11 se curto). */
export function fmtDate(iso: string | null | undefined, short = false): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return short ? `${m[3]}/${m[2]}` : `${m[3]}/${m[2]}/${m[1]}`;
}

export function fmtQty(n: number | null | undefined): string {
  if (n == null) return "";
  return Math.round(n).toLocaleString("pt-BR");
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(toIso.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(Date.parse(iso.slice(0, 10) + "T00:00:00Z") + days * 86400000);
  return d.toISOString().slice(0, 10);
}
