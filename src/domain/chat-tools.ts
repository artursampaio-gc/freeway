import type { DB, Env } from "../env";
import { all, todayBR } from "../db/q";
import { gdiGet, itapevaConfigured } from "../integrations/itapeva";
import { DESTINATION_LABEL, displayPi, fmtDate, fmtQty, IMPORT_STATUS_LABEL, SHIPMENT_STATUS_LABEL } from "../shared/labels";
import type { OrderView, UnitView } from "../shared/types";
import { loadViews } from "./view";

// Ferramentas que a IA da aba Perguntar pode chamar. Cada uma devolve texto
// curto (até MAX caracteres) para caber na conversa.
const MAX = 7000;
const cut = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}\n… (cortado)` : s);
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export const unitLine = (u: UnitView) =>
  [
    u.display,
    u.title ? `"${u.title}"` : "",
    u.products.slice(0, 3).join(", ") || u.description || "",
    u.supplier ?? "",
    `${Math.round(u.total * 100)}%`,
    u.situacao === "cancelado" ? "cancelado" : u.finalized ? "lançado no site" : u.situacao === "on_hold" ? "on hold" : `saúde ${u.health}`,
    `agora: ${u.current}`,
    u.next_milestone ? `próximo marco: ${u.next_milestone.label} ${fmtDate(u.next_milestone.date, true)}` : "",
    u.launch_due && !u.launched_at ? `lançamento previsto ${fmtDate(u.launch_due, true)}` : "",
  ].filter(Boolean).join(" · ");

/** Tudo de um pedido: etapas, próximos passos, itens, amostras e a leitura das notas. */
export function orderDetail(v: OrderView): string {
  const out = [`## ${v.process_code}${v.title ? ` · "${v.title}"` : ""} · ${v.description ?? ""} · ${v.supplier ?? ""} · importação ${IMPORT_STATUS_LABEL[v.po_status ?? ""] ?? v.po_status ?? "-"}${v.po_date ? ` · PO de ${fmtDate(v.po_date)}` : ""}`];
  if (v.ai?.resumo) out.push(`Notas da planilha (IA): ${v.ai.resumo}${v.ai.atencao ? ` · atenção: ${v.ai.atencao}` : ""}`);
  for (const s of v.samples) out.push(`Amostra no Monday: ${s.tracking || s.name}${s.approval ? ` · ${s.approval}` : ""} (${s.state})`);
  for (const u of v.units) {
    out.push(`### ${unitLine(u)}`);
    if (u.shipment) {
      const s = u.shipment;
      out.push(`Frete: ${s.status_label}${s.eta ? ` · ETA Santos ${fmtDate(s.eta)}` : ""}${s.etd ? ` · ETD ${fmtDate(s.etd)}` : ""}${s.destination ? ` · destino ${DESTINATION_LABEL[s.destination] ?? s.destination}` : ""}${s.canal ? ` · canal ${s.canal}` : ""}${s.delivery_forecast ? ` · previsão de entrega ${fmtDate(s.delivery_forecast)}` : ""}`);
    }
    for (const st of u.steps) {
      if (st.status === "na") continue;
      const pts = (st.points ?? []).map((p) => `${p.label}: ${p.done ? "pronta" : "pendente"}${p.link ? ` (${p.link})` : ""}`).join("; ");
      out.push(`- ${st.label}: ${st.status}${st.detail ? ` · ${st.detail}` : ""}${st.due ? ` · prazo ${fmtDate(st.due)}` : ""}${pts ? ` · ${pts}` : ""}`);
    }
    if (u.next_steps.length) out.push(`Próximos passos: ${u.next_steps.map((n) => n.label).join("; ")}`);
    if (u.items.length) {
      out.push(`Itens: ${u.items.slice(0, 25).map((i) => `${i.code ?? "?"} ${i.name ?? i.item_supplier ?? ""} ${fmtQty(i.qty)}${i.done_at ? " (industrializado)" : i.gdi ? ` (GDI ${fmtQty(i.gdi.done)} prontas, ${fmtQty(i.gdi.doing)} em OP)` : ""}`).join("; ")}${u.items.length > 25 ? ` … +${u.items.length - 25}` : ""}`);
    }
    for (const f of u.fiscal) {
      out.push(`Nota de importação (planilha do fiscal) ${f.processo}: ${f.status ?? "-"}${f.duimp ? ` · DUIMP ${f.duimp}` : ""}${f.nf ? ` · NF ${f.nf}` : ""}${f.valor ? ` · ${f.valor}` : ""} · etapas: ${f.etapas.map((e) => `${e.label} ${e.mark}${e.value ? ` (${e.value})` : ""}`).join("; ")}${f.falta ? ` · falta: ${f.falta}` : ""}`);
    }
    if (u.ai_note) out.push(`Nota do frete (IA): ${u.ai_note}`);
  }
  return out.join("\n");
}

type Tool = { doc: string; run: (db: DB, env: Env, args: Record<string, unknown>, user: string) => Promise<string> };

export const TOOLS: Record<string, Tool> = {
  pedido: {
    doc: `pedido {codigo}: tudo de um pedido da planilha de importação (etapas, fretes, itens, amostras, documentação, industrialização). Ex.: {"codigo":"BBI25205"}`,
    async run(db, _env, a, user) {
      const code = str(a.codigo).toUpperCase().match(/(GOC|BBI)\s?(\d{5})/);
      if (!code) return "Código inválido. Use GOC12345 ou BBI12345.";
      const [v] = await loadViews(db, [`${code[1]}${code[2]}`], user);
      return v ? orderDetail(v) : `${code[1]}${code[2]} não está no Freeway.`;
    },
  },
  buscar_pedidos: {
    doc: `buscar_pedidos {texto?, fornecedor?, status?}: procura pedidos por produto, SKU, descrição ou fornecedor; status = Aberta | Finalizada | Cancelada.`,
    async run(db, _env, a) {
      const like = `%${str(a.texto)}%`;
      const rows = await all(
        db,
        `SELECT o.process_code, o.description, o.supplier, o.po_status, o.production_status, o.po_date,
                (SELECT COUNT(*) FROM shipments s WHERE s.process_code = o.process_code AND s.removed_at IS NULL) AS fretes
           FROM orders o
          WHERE o.removed_at IS NULL AND (? = '' OR o.supplier LIKE ?) AND (? = '' OR o.po_status = ?)
            AND (? = '%%' OR o.description LIKE ? OR o.process_code LIKE ?
                 OR EXISTS (SELECT 1 FROM order_items i WHERE i.process_code = o.process_code AND (i.sku LIKE ? OR i.sku_code LIKE ?)))
          ORDER BY o.po_date DESC LIMIT 40`,
        [str(a.fornecedor), `%${str(a.fornecedor)}%`, str(a.status), str(a.status), like, like, like, like, like],
      );
      return rows.length
        ? rows.map((r) => `${r.process_code} · ${r.description ?? "-"} · ${r.supplier ?? "-"} · ${IMPORT_STATUS_LABEL[r.po_status] ?? r.po_status ?? "-"} · produção ${r.production_status ?? "-"} · PO ${fmtDate(r.po_date)} · ${r.fretes} frete(s)`).join("\n")
        : "Nenhum pedido encontrado.";
    },
  },
  fretes: {
    doc: `fretes {status?, eta_desde?, eta_ate?, fornecedor?, incluir_entregues?}: fretes (embarques) da planilha com status, ETA em Santos, previsão de entrega e destino. status = pronto | booking | transito | desembaraco | agendada | entregue | on_hold (lista por vírgula). Datas AAAA-MM-DD.`,
    async run(db, _env, a) {
      const statuses = str(a.status).split(",").map((s) => s.trim()).filter(Boolean);
      const desde = isDate(str(a.eta_desde)) ? str(a.eta_desde) : "";
      const ate = isDate(str(a.eta_ate)) ? str(a.eta_ate) : "";
      const rows = await all(
        db,
        `SELECT s.pi_number, s.process_code, s.status, s.eta, s.etd, s.delivery_forecast, s.delivered_at, s.destination, s.canal, s.qty, o.description, o.supplier,
                (SELECT COUNT(*) FROM shipments x WHERE x.process_code = s.process_code AND x.removed_at IS NULL) AS fretes
           FROM shipments s JOIN orders o ON o.process_code = s.process_code
          WHERE s.removed_at IS NULL AND COALESCE(o.po_status, '') <> 'Cancelada'
            AND (? = 1 OR s.status <> 'entregue')
            AND (? = '[]' OR s.status IN (SELECT value FROM json_each(?)))
            AND (? = '' OR s.eta >= ?) AND (? = '' OR s.eta <= ?) AND (? = '' OR o.supplier LIKE ?)
          ORDER BY COALESCE(s.eta, s.delivery_forecast, '9999') LIMIT 150`,
        [a.incluir_entregues || statuses.includes("entregue") ? 1 : 0, JSON.stringify(statuses), JSON.stringify(statuses), desde, desde, ate, ate, str(a.fornecedor), `%${str(a.fornecedor)}%`],
      );
      return rows.length
        ? `${rows.length} fretes:\n` + rows.map((s) =>
            [s.fretes > 1 ? displayPi(s.pi_number) : s.process_code, SHIPMENT_STATUS_LABEL[s.status] ?? s.status, s.etd && `ETD ${fmtDate(s.etd, true)}`, s.eta && `ETA ${fmtDate(s.eta, true)}`,
              s.delivery_forecast && `entrega prev. ${fmtDate(s.delivery_forecast, true)}`, s.delivered_at && `entregue ${fmtDate(s.delivered_at, true)}`,
              s.destination && (DESTINATION_LABEL[s.destination] ?? s.destination), s.canal && `canal ${s.canal}`, s.qty && `${fmtQty(s.qty)} un.`, s.supplier, (s.description ?? "").slice(0, 50)]
              .filter(Boolean).join(" · "),
          ).join("\n")
        : "Nenhum frete com esses filtros.";
    },
  },
  itapeva_ordens: {
    doc: `itapeva_ordens {item?, status?, desde?, ate?, campo?, numero?, pedido?}: ordens de produção (industrialização) no GDI de Itapeva, ao vivo. item = código WMS (SKU + "BR", ex.: TX241001BR); status = aguardando_planejamento, aguardando_separacao, em_separacao, abastecido, em_producao, pausado, concluido, cancelado (lista por vírgula); campo = criado_em (padrão), separacao_em, abastecido_em, producao_em, concluido_em, fiscal_em; desde/ate em AAAA-MM-DD. Só OP e OPI (sem dupla contagem).`,
    async run(_db, env, a) {
      if (!itapevaConfigured(env)) return "GDI não configurado.";
      const p: Record<string, string> = { tipo: "OP,OPI", limite: "2000" };
      for (const k of ["item", "status", "campo", "numero", "pedido"]) if (str(a[k])) p[k] = str(a[k]);
      for (const k of ["desde", "ate"]) if (isDate(str(a[k]))) p[k] = str(a[k]);
      if (!p.desde && !p.numero && !p.item && !p.pedido) p.desde = new Date(Date.parse(todayBR()) - 90 * 86400_000).toISOString().slice(0, 10);
      const r = await gdiGet(env, "/api/v1/gdi/ordens", p);
      const rows: any[] = r.linhas ?? [];
      const byStatus = new Map<string, { n: number; q: number }>();
      for (const o of rows) {
        const s = byStatus.get(o.status) ?? { n: 0, q: 0 };
        s.n++;
        s.q += Number(o.quantidade) || 0;
        byStatus.set(o.status, s);
      }
      const head = `${rows.length} OPs (${JSON.stringify(p)}) · por status: ${[...byStatus].map(([s, v]) => `${s}=${v.n} OPs/${fmtQty(v.q)} un.`).join(", ")}`;
      const lines = rows.slice(0, 80).map((o) =>
        [o.op_numero, o.item_codigo, o.descricao, `${fmtQty(o.quantidade)} un.`, o.status, o.canal, o.num_pedido && `pedido ${o.num_pedido}`, o.criado_em && `criada ${fmtDate(o.criado_em.slice(0, 10), true)}`,
          o.producao_em && `produção ${fmtDate(o.producao_em.slice(0, 10), true)}`, o.concluido_em && `concluída ${fmtDate(o.concluido_em.slice(0, 10), true)}`, o.rejeitos_qtd ? `rejeitos ${o.rejeitos_qtd}` : "", o.deadline && `deadline ${fmtDate(o.deadline, true)}`]
          .filter(Boolean).join(" · "),
      );
      return [head, ...lines, rows.length > 80 ? `… +${rows.length - 80} OPs` : ""].filter(Boolean).join("\n");
    },
  },
  itapeva_estoque: {
    doc: `itapeva_estoque {busca}: cadastro de itens do GDI com código, descrição, SKU WMS, saldo e custo médio; busca por código ou descrição.`,
    async run(_db, env, a) {
      if (!itapevaConfigured(env)) return "GDI não configurado.";
      const r = await gdiGet(env, "/api/webgex/codigos", {});
      const rows: any[] = r.linhas ?? r.codigos ?? (Array.isArray(r) ? r : []);
      const q = str(a.busca).toLowerCase();
      const hit = q ? rows.filter((x) => JSON.stringify(x).toLowerCase().includes(q)) : rows;
      return `${hit.length} itens${q ? ` com "${q}"` : ""}:\n${hit.slice(0, 60).map((x) => JSON.stringify(x)).join("\n")}`;
    },
  },
  itapeva_romaneios: {
    doc: `itapeva_romaneios {desde?, ate?}: carregamentos que saíram de Itapeva (paletes e unidades por carga). Datas AAAA-MM-DD.`,
    async run(_db, env, a) {
      if (!itapevaConfigured(env)) return "GDI não configurado.";
      const p: Record<string, string> = {};
      for (const k of ["desde", "ate"]) if (isDate(str(a[k]))) p[k] = str(a[k]);
      const r = await gdiGet(env, "/api/v1/gdi/romaneios", p);
      const rows: any[] = r.linhas ?? [];
      return `${rows.length} romaneios:\n${rows.slice(0, 60).map((x) => JSON.stringify(x)).join("\n")}`;
    },
  },
  itapeva_pausas: {
    doc: `itapeva_pausas {desde?, ate?}: paradas apontadas na produção de Itapeva, com motivo. A duração não é confiável (quase nenhuma pausa tem fim registrado): conte paradas e motivos, não meça tempo.`,
    async run(_db, env, a) {
      if (!itapevaConfigured(env)) return "GDI não configurado.";
      const p: Record<string, string> = {};
      for (const k of ["desde", "ate"]) if (isDate(str(a[k]))) p[k] = str(a[k]);
      const r = await gdiGet(env, "/api/v1/gdi/pausas", p);
      const rows: any[] = r.linhas ?? [];
      return `${rows.length} pausas:\n${rows.slice(0, 80).map((x) => JSON.stringify(x)).join("\n")}`;
    },
  },
  estoque_wms: {
    doc: `estoque_wms {busca}: estoque no WMS (Extrema, Itapeva, Linhares) por produto, com saldo por variação do código (NA nacional, BR bruto, NF com NFC, MN manual, QR, QM) e armazém, mais status, origem e fornecedor da planilha de produtos (supply). Busca por código (TX221004) ou nome.`,
    async run(db, _env, a) {
      const q = str(a.busca);
      if (!q) return "Informe um código ou parte do nome.";
      const prods = await all(
        db,
        `SELECT base_code, sku_unico, categoria, linha, status, origem, fornecedor, leadtime FROM product_codes
          WHERE base_code LIKE ? OR sku_unico LIKE ? ORDER BY base_code LIMIT 15`,
        [`${q.toUpperCase()}%`, `%${q}%`],
      );
      if (!prods.length) return `Nenhum produto com "${q}" na planilha de produtos.`;
      const stock = await all(
        db,
        `SELECT base_code, codigo, armazem, saldo_disponivel, saldo_total FROM wms_stock WHERE base_code IN (SELECT value FROM json_each(?)) AND saldo_total <> 0 ORDER BY codigo, armazem`,
        [JSON.stringify(prods.map((p) => p.base_code))],
      );
      const names = await all<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'wms_armazens'`);
      const armazens: Record<string, string> = names[0] ? JSON.parse(names[0].value).armazens ?? {} : {};
      return prods.map((p) => {
        const rows = stock.filter((s) => s.base_code === p.base_code);
        return [
          `${p.base_code} · ${p.sku_unico ?? "-"} · ${p.linha ?? ""} · status ${p.status ?? "-"} · ${p.origem ?? ""}${p.fornecedor ? ` · fornecedor ${p.fornecedor}` : ""}${p.leadtime ? ` · leadtime ${p.leadtime}` : ""}`,
          rows.length ? rows.map((s) => `  - ${s.codigo} em ${armazens[s.armazem] ?? s.armazem} (${s.armazem}): ${fmtQty(s.saldo_total)} (disponível ${fmtQty(s.saldo_disponivel)})`).join("\n") : "  - sem saldo no WMS",
        ].join("\n");
      }).join("\n");
    },
  },
  monday: {
    doc: `monday {busca, quadro?}: itens dos quadros do Monday lidos pelo Freeway (Launches 2026/2027, Novas Cases, 01 Samples China, 02 Warehouse Samples, 04 Inspection China, 06 Shipping Schedule, 07 Reorders), com grupo e colunas. Busca por texto no nome, nas colunas ou no código do pedido.`,
    async run(db, _env, a) {
      const like = `%${str(a.busca)}%`;
      const rows = await all(
        db,
        `SELECT m.name, m.group_title, m.vals, m.process_codes, m.updated_at, b.value AS quadro
           FROM monday_items m
           LEFT JOIN (SELECT json_extract(j.value, '$.id') AS id, json_extract(j.value, '$.name') AS value
                        FROM settings s, json_each(s.value) j WHERE s.key = 'monday_boards') b ON b.id = m.board_id
          WHERE (m.name LIKE ? OR m.vals LIKE ? OR m.process_codes LIKE ? OR m.group_title LIKE ?) AND (? = '' OR b.value LIKE ?)
          ORDER BY m.updated_at DESC LIMIT 30`,
        [like, like, like, like, str(a.quadro), `%${str(a.quadro)}%`],
      );
      return rows.length
        ? rows.map((r) => `[${r.quadro ?? "?"}] ${r.name} · grupo ${r.group_title ?? "-"} · pedidos ${r.process_codes} · ${Object.entries(JSON.parse(r.vals ?? "{}")).filter(([k]) => !/photo|image|arquivo|relatorio|ficha|file/i.test(k)).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join("; ")}`).join("\n")
        : "Nada no Monday com essa busca.";
    },
  },
};

/** Executa uma ferramenta pedida pela IA, devolvendo sempre texto (erros também). */
export async function runTool(db: DB, env: Env, name: string, args: Record<string, unknown>, user: string): Promise<string> {
  const tool = TOOLS[name];
  if (!tool) return `Ferramenta desconhecida: ${name}. Use uma destas: ${Object.keys(TOOLS).join(", ")}.`;
  try {
    return cut(await tool.run(db, env, args ?? {}, user));
  } catch (err) {
    return `Erro ao consultar ${name}: ${(err as Error).message.slice(0, 300)}`;
  }
}
