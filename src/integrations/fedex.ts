import type { DB, Env } from "../env";
import { all, nowIso, run } from "../db/q";
import { insertEvents, type NewEvent } from "../domain/events";
import { notifyForEvents } from "../domain/rules";

const BASE = "https://apis.fedex.com";
/** Ambiente de teste da FedEx: só usado para avisar quando gravaram as chaves de teste no lugar das de produção. */
const SANDBOX = "https://apis-sandbox.fedex.com";

/** Número de rastreio como a FedEx espera: só os dígitos (tira "FEDEX", espaços, traços). */
export const fedexNumber = (v: unknown): string => String(v ?? "").replace(/\D/g, "");

export class FedexError extends Error {
  constructor(public status: number, public code: string) {
    super(`FedEx OAuth ${status}${code ? ` ${code}` : ""}`);
  }
}

export function fedexConfigured(env: Env): boolean {
  return !!(env.FEDEX_CLIENT_ID && env.FEDEX_CLIENT_SECRET);
}

async function token(env: Env, base = BASE): Promise<string> {
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.FEDEX_CLIENT_ID!.trim(),
      client_secret: env.FEDEX_CLIENT_SECRET!.trim(),
    }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { errors?: { code?: string }[] } | null;
    throw new FedexError(res.status, j?.errors?.[0]?.code ?? "");
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

export interface FedexStatus {
  code: string | null;
  label: string | null;
  est_delivery: string | null;
  delivered_at: string | null;
  checked_at: string;
  error?: string;
}

async function track(env: Env, numbers: string[]): Promise<Map<string, FedexStatus>> {
  const out = new Map<string, FedexStatus>();
  const auth = await token(env);
  for (let i = 0; i < numbers.length; i += 30) {
    const batch = numbers.slice(i, i + 30);
    const res = await fetch(`${BASE}/track/v1/trackingnumbers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}`, "X-locale": "pt_BR" },
      body: JSON.stringify({
        includeDetailedScans: false,
        trackingInfo: batch.map((n) => ({ trackingNumberInfo: { trackingNumber: n } })),
      }),
    });
    const checked_at = nowIso();
    if (!res.ok) {
      for (const n of batch) out.set(n, { code: null, label: null, est_delivery: null, delivered_at: null, checked_at, error: `HTTP ${res.status}` });
      continue;
    }
    const json = (await res.json()) as any;
    for (const r of json?.output?.completeTrackResults ?? []) {
      const t = r.trackResults?.[0] ?? {};
      const dates: { type: string; dateTime: string }[] = t.dateAndTimes ?? [];
      const find = (type: string) => dates.find((d) => d.type === type)?.dateTime?.slice(0, 10) ?? null;
      const code = t.latestStatusDetail?.code ?? null;
      out.set(r.trackingNumber, {
        code,
        label: t.latestStatusDetail?.description ?? t.latestStatusDetail?.statusByLocale ?? null,
        est_delivery: find("ESTIMATED_DELIVERY") ?? t.estimatedDeliveryTimeWindow?.window?.ends?.slice(0, 10) ?? null,
        delivered_at: code === "DL" ? find("ACTUAL_DELIVERY") ?? checked_at.slice(0, 10) : null,
        checked_at,
        error: t.error?.message,
      });
    }
  }
  return out;
}

/** Atualiza os rastreios FedEx em aberto (amostra e alinhamento) dos pedidos ativos. */
export async function refreshFedex(db: DB, env: Env, onlyCodes?: string[]): Promise<{ checked: number; delivered: number }> {
  if (!fedexConfigured(env)) return { checked: 0, delivered: 0 };
  const rows = await all<{ scope: string; step_key: string; data: string }>(
    db,
    `SELECT s.scope, s.step_key, s.data FROM step_state s
      WHERE s.step_key IN ('amostra', 'alinhamento')
        AND EXISTS (SELECT 1 FROM watchers w WHERE w.process_code = s.scope)`,
  );
  const open = rows
    .map((r) => ({ ...r, d: JSON.parse(r.data) as Record<string, any> }))
    .filter((r) => r.d.tracking && (r.d.carrier ?? "fedex") === "fedex" && !r.d.delivered_at && !r.d.fedex?.delivered_at)
    .filter((r) => !onlyCodes || onlyCodes.includes(r.scope));
  if (!open.length) return { checked: 0, delivered: 0 };

  const results = await track(env, [...new Set(open.map((r) => fedexNumber(r.d.tracking)).filter(Boolean))]);
  const events: NewEvent[] = [];
  for (const r of open) {
    const st = results.get(fedexNumber(r.d.tracking));
    if (!st) continue;
    r.d.fedex = st;
    await run(db, `UPDATE step_state SET data = ?, updated_at = ? WHERE scope = ? AND step_key = ?`, [JSON.stringify(r.d), nowIso(), r.scope, r.step_key]);
    if (st.delivered_at) {
      const amostra = r.step_key === "amostra";
      events.push({
        process_code: r.scope,
        step_key: r.step_key,
        type: amostra ? "amostra_entregue" : "alinhamento_entregue",
        message: amostra
          ? `Amostra entregue em ${r.d.destination || "Fortaleza"} (FedEx)`
          : `20 amostras de alinhamento entregues em Extrema (FedEx). Prazo de 10 dias começou.`,
        new_value: st.delivered_at,
        actor: "fedex",
      });
    }
  }
  await insertEvents(db, events);
  await notifyForEvents(db, events);
  return { checked: open.length, delivered: events.length };
}

/** Um rastreio real para o teste: o de uma amostra no Freeway ou, sem nenhum, o mais recente do Warehouse Samples no Monday. */
async function sampleNumber(db: DB): Promise<string | null> {
  const steps = await all<{ data: string }>(db, `SELECT data FROM step_state WHERE step_key IN ('amostra', 'alinhamento') AND data LIKE '%tracking%' ORDER BY updated_at DESC LIMIT 50`);
  for (const r of steps) {
    const d = JSON.parse(r.data) as Record<string, any>;
    const n = fedexNumber(d.tracking);
    if ((d.carrier ?? "fedex") === "fedex" && n.length >= 12) return n;
  }
  const items = await all<{ name: string }>(db, `SELECT name FROM monday_items WHERE name LIKE '%FEDEX%' ORDER BY updated_at DESC LIMIT 30`);
  for (const it of items) {
    const m = (it.name ?? "").match(/FEDEX\s*#?\s*(\d{12,22})/i);
    if (m) return m[1];
  }
  return null;
}

/** Teste das chaves pela tela de Configuração: pede o acesso à FedEx e consulta um rastreio real. */
export async function testFedex(db: DB, env: Env): Promise<{ ok: boolean; message: string; number?: string; label?: string | null }> {
  if (!fedexConfigured(env)) return { ok: false, message: "faltam as chaves da FedEx (FEDEX_CLIENT_ID e FEDEX_CLIENT_SECRET)" };
  try {
    await token(env);
  } catch (e) {
    if (e instanceof FedexError && (e.status === 401 || e.status === 403)) {
      if (await token(env, SANDBOX).then(() => true, () => false))
        return { ok: false, message: "essas são as chaves de teste (sandbox), que só trazem rastreios fictícios; gere as chaves de produção no projeto da FedEx" };
      return { ok: false, message: "a FedEx recusou as chaves; confira se a API Key está em FEDEX_CLIENT_ID e a Secret Key em FEDEX_CLIENT_SECRET" };
    }
    return { ok: false, message: `não deu para falar com a FedEx (${(e as Error).message})` };
  }
  const number = await sampleNumber(db);
  if (!number) return { ok: true, message: "chaves aceitas pela FedEx; não há nenhum rastreio no Freeway para consultar agora" };
  const st = (await track(env, [number])).get(number);
  if (st?.error === "HTTP 403") return { ok: false, number, message: "chaves aceitas, mas o projeto da FedEx não tem a Track API; adicione a Track API ao projeto" };
  if (!st || st.error) return { ok: true, number, message: `chaves aceitas; a FedEx não achou o rastreio ${number}${st?.error ? ` (${st.error})` : ""}` };
  return { ok: true, number, label: st.label, message: `funcionando: rastreio ${number} · ${st.label ?? st.code ?? "sem status"}${st.delivered_at ? ` em ${st.delivered_at}` : ""}` };
}
