import { daysBetween, fmtDate } from "../shared/labels";
import type { StepStatus, StepView } from "../shared/types";
import type { StepDef } from "./steps";

// Peças comuns para montar uma etapa (usadas pelo pedido e pelos lançamentos em desenvolvimento).

export const RISK_DAYS = 5;

export function step(def: StepDef, status: StepStatus, progress: number, detail: string, extra: Partial<StepView> = {}): StepView {
  return {
    key: def.key,
    label: def.label,
    short: def.short,
    track: def.track,
    scope: def.scope,
    status,
    progress: status === "done" ? 1 : status === "na" ? 0 : Math.max(0, Math.min(1, progress)),
    detail,
    ...extra,
  };
}

/** Aplica prazo: atrasado se passou, em risco se faltam ≤ 5 dias. */
export function withDue(status: StepStatus, due: string | null | undefined, today: string): StepStatus {
  if (!due || status === "done" || status === "na" || status === "blocked") return status;
  const left = daysBetween(today, due);
  if (left < 0) return "late";
  if (left <= RISK_DAYS && status !== "late") return "risk";
  return status;
}

export function dueText(due: string | null | undefined, today: string): string {
  if (!due) return "";
  const left = daysBetween(today, due);
  if (left < 0) return `prazo ${fmtDate(due, true)} (${-left} dia${left === -1 ? "" : "s"} de atraso)`;
  if (left === 0) return `prazo hoje`;
  return `prazo ${fmtDate(due, true)} (faltam ${left} dia${left === 1 ? "" : "s"})`;
}

export function trackingDelivered(d: Record<string, any>): string | null {
  return d.delivered_at ?? d.fedex?.delivered_at ?? null;
}

export function trackingText(d: Record<string, any>): string {
  if (d.fedex?.label) return `FedEx: ${d.fedex.label}${d.fedex.est_delivery ? ` · previsão ${fmtDate(d.fedex.est_delivery, true)}` : ""}`;
  if (d.tracking) return `Rastreio ${d.tracking}`;
  return "";
}

