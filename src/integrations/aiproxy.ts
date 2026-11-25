import type { Env } from "../env";

const ENDPOINT = "https://ai-proxy.gogroupbr.com/v1/chat/completions";

export function aiConfigured(env: Env): boolean {
  return !!env.AI_PROXY_TOKEN;
}

/** Extrai o objeto JSON da resposta, mesmo que venha dentro de ```json ... ```. */
export function parseJsonReply(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("A IA não respondeu em JSON");
  return JSON.parse(text.slice(start, end + 1));
}

/** Conversa livre: devolve o texto da resposta. */
export async function chatText(env: Env, messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AI_PROXY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "latest", messages }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`AI Proxy ${res.status}: ${body.slice(0, 300)}`);
  return String(JSON.parse(body)?.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Chama o AI Proxy (formato chat completions) e devolve a resposta já como JSON.
 * `images` são data URLs (ou links) enviados junto com o texto, para a IA ler.
 */
export async function chatJson(env: Env, system: string, user: string, images: string[] = []): Promise<{ data: any; model: string | null; tokens: number | null }> {
  const userContent = images.length ? [{ type: "text", text: user }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : user;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AI_PROXY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "latest",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`AI Proxy ${res.status}: ${body.slice(0, 300)}`);
  const json = JSON.parse(body);
  const content: string = json?.choices?.[0]?.message?.content ?? "";
  return { data: parseJsonReply(content), model: json?.model ?? null, tokens: json?.usage?.total_tokens ?? null };
}
