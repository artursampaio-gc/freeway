import type { DB, Env } from "../env";
import { all, todayBR } from "../db/q";
import { chatText, parseJsonReply } from "../integrations/aiproxy";
import { fmtDate } from "../shared/labels";
import { HttpError } from "./actions";
import { orderDetail, runTool, TOOLS, unitLine } from "./chat-tools";
import { loadViews } from "./view";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Quanto da conversa vai para a IA, quantos pedidos citados entram já detalhados
// e quantas consultas ela pode fazer antes de responder.
const HISTORY = 8;
const DETAILED = 4;
const MAX_STEPS = 5;

const SYSTEM = `Você é o assistente do Freeway, o rastreador de pedidos de importação da Gocase (processos GOC e BBI).
Responda em português, curto e direto, com base nos dados do contexto e no que as ferramentas devolverem. Não invente datas nem números.
Pedido dividido em mais de um frete aparece como BBI25205.1, .2…; com um frete só, só o código (BBI25137). Sempre cite os códigos.
Fontes: a planilha de importação (pedidos e fretes, a base de supply), a planilha de produtos e estoque (de-para de códigos e saldo no WMS), o GDI de Itapeva (ordens de produção, estoque, romaneios, pausas), os quadros do Monday e o que é marcado no Freeway.
Use as ferramentas sempre que a pergunta pedir um dado que não está no contexto. Pode consultar várias vezes antes de responder.

Responda SEMPRE com um único JSON, sem texto fora dele:
- para consultar: {"acao":"consultar","ferramenta":"<nome>","argumentos":{...}}
- para responder: {"acao":"responder","texto":"<resposta; pode usar listas com - e **negrito**>"}

Ferramentas:
${Object.entries(TOOLS).map(([, t]) => `- ${t.doc}`).join("\n")}`;

interface Step {
  acao: string;
  ferramenta?: string;
  argumentos?: Record<string, unknown>;
  texto?: string;
}

/** Responde uma pergunta sobre os dados com a IA da empresa, que consulta as fontes conforme precisa. */
export async function chat(db: DB, env: Env, user: string, messages: ChatMessage[]): Promise<{ answer: string; consultas: string[] }> {
  const history = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!history.some((m) => m.role === "user")) throw new HttpError(400, "Faça uma pergunta");

  // Contexto inicial: os pedidos observados e, detalhados, os pedidos citados na conversa.
  const userText = history.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const cited = [...new Set([...userText.matchAll(/\b(GOC|BBI)\s?(\d{5})/gi)].map((m) => `${m[1].toUpperCase()}${m[2]}`))].slice(-DETAILED);
  const watched = (await all<{ process_code: string }>(db, `SELECT process_code FROM watchers WHERE user_email = ? ORDER BY created_at DESC LIMIT 40`, [user])).map((r) => r.process_code);
  const views = await loadViews(db, [...new Set([...cited, ...watched])], user);
  const byCode = new Map(views.map((v) => [v.process_code, v]));
  const context = [
    `Hoje: ${fmtDate(todayBR())} (${todayBR()}). Quem pergunta: ${user}.`,
    `# Pedidos que ${user} segue`,
    ...views.filter((v) => watched.includes(v.process_code)).flatMap((v) => v.units.map(unitLine)),
    ...cited.map((c) => (byCode.get(c) ? `\n# Detalhes\n${orderDetail(byCode.get(c)!)}` : `\n# ${c}: não encontrado no Freeway`)),
  ].join("\n");

  const convo: { role: string; content: string }[] = [{ role: "system", content: SYSTEM }, { role: "system", content: context }, ...history];
  const consultas: string[] = [];
  for (let i = 0; i <= MAX_STEPS; i++) {
    if (i === MAX_STEPS) convo.push({ role: "user", content: "Responda agora com o que já tem (acao responder)." });
    const reply = await chatText(env, convo);
    let step: Step;
    try {
      step = parseJsonReply(reply);
    } catch {
      return { answer: reply, consultas }; // Respondeu em texto puro: vale como resposta.
    }
    if (step.acao !== "consultar" || !step.ferramenta || i === MAX_STEPS) return { answer: String(step.texto ?? reply), consultas };
    const label = `${step.ferramenta} ${JSON.stringify(step.argumentos ?? {})}`;
    consultas.push(label);
    const result = await runTool(db, env, step.ferramenta, step.argumentos ?? {}, user);
    convo.push({ role: "assistant", content: reply }, { role: "user", content: `Resultado de ${label}:\n${result}` });
  }
  return { answer: "Não consegui responder.", consultas };
}
