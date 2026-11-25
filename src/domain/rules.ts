import type { DB } from "../env";
import { all, todayBR } from "../db/q";
import { daysBetween, displayPi, fmtDate, SHIPMENT_STATUS_LABEL } from "../shared/labels";
import type { StepView } from "../shared/types";
import type { NewEvent } from "./events";
import { deliver, type NotificationSpec } from "./notify";
import { STEP_BY_KEY } from "./steps";
import { loadViews } from "./view";

/** Transforma eventos (planilha, FedEx ou ações no app) em notificações. */
export function specsForEvents(events: NewEvent[]): NotificationSpec[] {
  const out: NotificationSpec[] = [];
  for (const e of events) {
    const code = e.process_code;
    const pi = e.pi_number ?? null;
    // Cada frete é um pedido: a chave usa a PI; o título, o código como as pessoas veem.
    const unit = pi ?? code;
    const label = e.unit_label ?? (pi ? displayPi(pi) : code);
    const base = { process_code: code, pi_number: pi, step_key: e.step_key ?? null, kind: e.type, exclude: e.actor.includes("@") ? e.actor : null };
    switch (e.type) {
      case "sefaz_liberada":
        out.push({ ...base, nkey: `sefaz:${unit}`, teams: ["itapeva"], title: `${label}: desembaraço concluído`, body: "SEFAZ liberada. O embarque pode seguir para Itapeva." });
        break;
      case "embarque_status": {
        const st = e.new_value ?? "";
        if (st === "on_hold") out.push({ ...base, nkey: `onhold:${unit}:${todayBR()}`, title: `${label} está on hold`, body: e.message });
        else out.push({ ...base, nkey: `status:${unit}:${st}`, title: `${label}: ${SHIPMENT_STATUS_LABEL[st] ?? st}`, body: e.message });
        break;
      }
      case "eta_mudou":
        out.push({ ...base, nkey: `eta:${unit}:${e.new_value}`, title: `${label}: ETA mudou para ${fmtDate(e.new_value)}`, body: e.message });
        break;
      case "canal":
        if (e.new_value === "Vermelho") out.push({ ...base, nkey: `canal:${unit}:vermelho`, title: `${label}: canal vermelho`, body: e.message });
        break;
      case "novo_embarque":
        out.push({ ...base, nkey: `novo:${unit}`, title: label.includes(".") ? `Novo frete ${label}` : `${label}: embarque registrado`, body: e.message });
        break;
      case "producao_status":
        out.push({ ...base, nkey: `prod:${code}:${e.new_value}`, title: `${code}: ${e.message}` });
        break;
      case "amostra_entregue":
        out.push({ ...base, nkey: `amostra_entregue:${code}`, title: `${code}: amostra entregue`, body: "Registre a aprovação da amostra." });
        break;
      case "amostra_aprovada":
        out.push({ ...base, nkey: `amostra_aprovada:${code}`, teams: ["filmagem"], title: `${code}: amostra aprovada`, body: "Próximos passos: entregar as amostras ao time de filmagem e avisar o time de ilustração." });
        break;
      case "amostra_reprovada":
        out.push({ ...base, nkey: `amostra_reprovada:${code}:${todayBR()}`, title: `${code}: amostra reprovada`, body: e.message });
        break;
      case "alinhamento_entregue":
        out.push({ ...base, nkey: `alinhamento_entregue:${code}`, title: `${code}: amostras de alinhamento chegaram em Extrema`, body: e.message });
        break;
      case "ilustracao_avisada":
        out.push({ ...base, nkey: `ilustracao:${unit}`, teams: ["ilustracao"], watchers: false, title: `${label}: verificar estampas`, body: "Amostra aprovada. Avalie se é preciso criar ou adaptar estampas para o produto." });
        break;
      case "estampas_decisao":
        out.push({ ...base, nkey: `estampas:${unit}:${e.new_value}`, title: `${label}: ${e.message}` });
        break;
      case "filmagem_entregue":
        out.push({ ...base, nkey: `filmagem_entregue:${unit}`, teams: ["filmagem"], watchers: false, title: `${label}: amostras entregues à filmagem`, body: "Informe o prazo da filmagem no Freeway." });
        break;
      case "filmagem_prazo":
        out.push({ ...base, nkey: `filmagem_prazo:${unit}:${e.new_value}`, title: `${label}: filmagem com prazo ${fmtDate(e.new_value)}` });
        break;
      case "videos_prontos":
        out.push({ ...base, nkey: `videos:${unit}`, teams: ["marketing"], title: `${label}: vídeos prontos`, body: e.link ? `Link dos vídeos: ${e.link}` : e.message });
        break;
      case "filmagem_concluida":
        out.push({ ...base, nkey: `filmagem_concluida:${unit}`, teams: ["marketing"], title: `${label}: filmagem concluída`, body: "O marketing do produto pode começar." });
        break;
      case "documentacao_pronta":
        out.push({ ...base, nkey: `docs:${code}`, title: `${code}: documentação do pedido pronta`, body: e.link ? `Arquivos: ${e.link}` : "Carton marks e barcodes gerados." });
        break;
      case "mockups_concluidos":
        out.push({ ...base, nkey: `mockups:${unit}`, teams: ["ecommerce"], title: `${label}: mockups prontos`, body: "Cadastrar o produto no site e no WMS." });
        break;
      case "lancado":
        out.push({ ...base, nkey: `lancado:${unit}`, teams: ["marketing"], title: `${label}: lançado no site`, body: e.message });
        break;
      case "etapa_concluida":
        out.push({ ...base, nkey: `done:${unit}:${e.step_key}`, title: e.message });
        break;
      case "industrializacao_concluida":
        out.push({ ...base, nkey: `ind:${unit}`, title: `${label}: industrialização concluída` });
        break;
    }
  }
  return out;
}

export async function notifyForEvents(db: DB, events: NewEvent[]): Promise<number> {
  return deliver(db, specsForEvents(events));
}

function dueSpecs(s: StepView, code: string, unit: string, pi: string | null, label: string, today: string): NotificationSpec[] {
  if (!s.due || s.status === "done" || s.status === "na" || s.inherited) return [];
  const left = daysBetween(today, s.due);
  const base = { process_code: code, pi_number: pi, step_key: s.key };
  if (s.key === "producao") {
    if (left >= 0 && left <= 5) {
      return [{
        ...base, nkey: `d5:${code}:${s.due}`, kind: "d5_producao", teams: ["importacao"],
        title: `${code}: produção termina em ${left} dia${left === 1 ? "" : "s"}`,
        body: `Prazo previsto ${fmtDate(s.due)}. Acionar o time de Importação.`,
      }];
    }
    if (left < 0) return [{ ...base, nkey: `prod_atrasada:${code}:${s.due}`, kind: "atraso", title: `${code}: produção atrasada`, body: `Prazo era ${fmtDate(s.due)}.` }];
    return [];
  }
  const team = STEP_BY_KEY[s.key]?.team;
  if (s.status === "late") {
    return [{ ...base, nkey: `atraso:${unit}:${s.key}:${s.due}`, kind: "atraso", teams: team ? [team] : [], title: `${label}: ${s.label} atrasado`, body: s.detail }];
  }
  if (s.status === "risk" && left <= 2) {
    return [{ ...base, nkey: `risco:${unit}:${s.key}:${s.due}`, kind: "risco", title: `${label}: ${s.label} vence em ${left} dia${left === 1 ? "" : "s"}`, body: s.detail }];
  }
  return [];
}

/** Dias úteis (segunda a sexta) depois de `from` até `to`. */
export function businessDays(from: string, to: string): number {
  let n = 0;
  const end = Date.parse(`${to}T12:00:00Z`);
  for (let t = Date.parse(`${from}T12:00:00Z`) + 86400000; t <= end; t += 86400000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

/**
 * Regras de prazo (D-5 da produção, prazos estourando). Rodam no cron diário
 * e logo depois de cada alteração manual no pedido.
 */
export async function runTimeRules(db: DB, codes?: string[]): Promise<number> {
  const list =
    codes ?? (await all<{ process_code: string }>(db, `SELECT DISTINCT process_code FROM watchers`)).map((r) => r.process_code);
  const views = await loadViews(db, list);
  const today = todayBR();
  const specs: NotificationSpec[] = [];
  for (const v of views) {
    const code = v.process_code;
    // Cancelado ou on hold (no app) não cobra prazo nenhum.
    if (v.hold || v.po_status === "Cancelada") continue;
    // Etapas do pedido, e o que foi marcado no pedido para todos os embarques: uma vez por pedido.
    for (const s of v.steps) specs.push(...dueSpecs(s, code, code, null, code, today));
    // Etapas de cada processo (pedido, saldo ou embarque).
    for (const u of v.units) {
      if (u.finalized) continue;
      for (const s of u.steps.filter((x) => x.scope === "unit")) specs.push(...dueSpecs(s, code, u.unit, u.pi_number, u.display, today));
    }
    // Documentação enviada e produção sem prazo de conclusão: cobra quem observa a cada 2 dias úteis até informarem.
    const prod = v.steps.find((s) => s.key === "producao");
    const docsAt: string | null = v.steps.find((s) => s.key === "documentacao")?.data?.docs_done_at ?? null;
    if (prod && docsAt && !prod.due && prod.status !== "done" && prod.status !== "na") {
      const round = Math.floor(businessDays(docsAt, today) / 2);
      specs.push({
        nkey: `prazo_producao:${code}:${round}`, process_code: code, step_key: "producao", kind: "prazo_producao",
        title: `${code}: informe o prazo de conclusão da produção`,
        body: `A documentação foi enviada em ${fmtDate(docsAt)} e a produção começou. Informe o prazo de conclusão no Freeway, na etapa Produção.`,
      });
    }
    // Alinhamento ainda aberto quando um embarque já concluiu o desembaraço.
    const al = v.steps.find((s) => s.key === "alinhamento");
    if (al && al.status !== "na" && al.status !== "done" && v.units.some((u) => u.shipment?.sefaz_at)) {
      specs.push({ nkey: `alinhamento_sefaz:${code}`, process_code: code, step_key: "alinhamento", kind: "risco", title: `${code}: embarque desembaraçado antes do alinhamento de matriz`, body: al.detail });
    }
  }
  return deliver(db, specs);
}
