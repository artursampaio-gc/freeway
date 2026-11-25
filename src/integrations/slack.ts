import type { Env } from "../env";

// API Web do Slack com o token do bot do app Freeway: users.lookupByEmail (users:read + users:read.email),
// chat.postMessage para o id da pessoa (chat:write, cai na aba Mensagens do app) e, para a foto do cartão do aviso,
// o envio da imagem sem postar em canal nenhum (files:write; sem essa permissão o cartão sai sem foto).

export const SLACK_SCOPES = ["chat:write", "users:read", "users:read.email"];
/** Permissão opcional: a foto do produto no cartão do aviso. */
export const SLACK_FILES_SCOPE = "files:write";

export const slackConfigured = (env: Env): boolean => !!env.SLACK_BOT_TOKEN;

/** Tipo do token gravado, só pelo prefixo (o token em si nunca sai daqui). */
export function slackTokenKind(env: Env): "bot" | "usuario" | "app" | "outro" | null {
  const t = env.SLACK_BOT_TOKEN?.trim();
  if (!t) return null;
  if (t.startsWith("xoxb-")) return "bot";
  if (t.startsWith("xoxp-")) return "usuario";
  if (t.startsWith("xapp-")) return "app";
  return "outro";
}

export class SlackError extends Error {
  constructor(public code: string, public retryAfter?: number, public needed?: string, public provided?: string) {
    super(code);
  }
}

async function slackApi(env: Env, method: string, body: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN?.trim()}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: new URLSearchParams(body).toString(),
  });
  if (res.status === 429) throw new SlackError("ratelimited", Number(res.headers.get("Retry-After")) || 30);
  const data = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as Record<string, any>;
  if (!data.ok) throw new SlackError(String(data.error ?? "erro"), undefined, data.needed ? String(data.needed) : undefined, data.provided != null ? String(data.provided) : undefined);
  return data;
}

/** Id do usuário no Slack pelo e-mail; null quando o e-mail não está no workspace. */
export async function slackUserId(env: Env, email: string): Promise<string | null> {
  try {
    const d = await slackApi(env, "users.lookupByEmail", { email });
    return d.user?.deleted ? null : (d.user?.id ?? null);
  } catch (e) {
    if (e instanceof SlackError && e.code === "users_not_found") return null;
    throw e;
  }
}

/**
 * Mensagem direta do app para a pessoa (aba Mensagens do app Freeway no Slack). Com foto (slack_file), o Slack às vezes
 * ainda não reconhece a imagem logo depois do envio: tenta de novo em 1,5 s e, se não der, manda sem a foto.
 */
export async function slackPost(env: Env, userId: string, text: string, blocks: unknown[], noImage?: unknown[]): Promise<void> {
  const post = (b: unknown[]) => slackApi(env, "chat.postMessage", { channel: userId, text, blocks: JSON.stringify(b), unfurl_links: "false", unfurl_media: "false" });
  try {
    await post(blocks);
  } catch (e) {
    if (!noImage || !(e instanceof SlackError) || e.code !== "invalid_blocks") throw e;
    await new Promise((r) => setTimeout(r, 1500));
    await post(blocks).catch(() => post(noImage));
  }
}

/** Envia uma imagem ao Slack sem postar em canal nenhum (fica com o app) e devolve o id do arquivo, para usar no cartão. */
export async function slackUploadImage(env: Env, bytes: Uint8Array, filename: string, title: string): Promise<string> {
  const u = await slackApi(env, "files.getUploadURLExternal", { filename, length: String(bytes.length) });
  const up = await fetch(String(u.upload_url), { method: "POST", body: bytes as unknown as BodyInit });
  if (!up.ok) throw new SlackError(`upload_${up.status}`);
  await slackApi(env, "files.completeUploadExternal", { files: JSON.stringify([{ id: u.file_id, title }]) });
  return String(u.file_id);
}

/** Detalhe guardado de um erro do Slack (código + permissões, quando o Slack informa). */
export interface SlackErrorInfo {
  code: string;
  needed?: string;
  provided?: string;
  kind?: string | null;
}

export function slackErrorInfo(env: Env, e: unknown): SlackErrorInfo {
  if (e instanceof SlackError) return { code: e.code, needed: e.needed, provided: e.provided, kind: slackTokenKind(env) };
  return { code: (e as Error).message, kind: slackTokenKind(env) };
}

/** Erro do Slack em português, para a tela e o registro. */
export function slackErrorText(code: string | SlackErrorInfo): string {
  const i = typeof code === "string" ? { code } : code;
  if (i.code === "missing_scope" || i.code === "not_allowed_token_type") {
    if (i.kind && i.kind !== "bot")
      return `o token gravado no GoDeploy não é o do bot (começa com ${i.kind === "usuario" ? "xoxp-" : i.kind === "app" ? "xapp-" : "outro prefixo"}); grave o "Bot User OAuth Token", que começa com xoxb-`;
    if (i.needed) {
      const have = (i.provided ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const missing = SLACK_SCOPES.filter((s) => !have.includes(s));
      return `falta a permissão ${missing.length ? missing.join(", ") : i.needed} no app do Slack (o token tem: ${have.length ? have.join(", ") : "nenhuma"}); adicione em OAuth & Permissions → Bot Token Scopes, reinstale o app e grave o token novo`;
    }
    return `falta permissão no app do Slack (${SLACK_SCOPES.join(", ")})`;
  }
  const map: Record<string, string> = {
    not_authed: "token do Slack ausente",
    invalid_auth: "token do Slack inválido",
    token_revoked: "token do Slack revogado",
    account_inactive: "app do Slack desativado",
    users_not_found: "e-mail não encontrado no Slack",
    user_not_found: "usuário não encontrado no Slack",
    channel_not_found: "conversa com o usuário não encontrada",
    cannot_dm_bot: "não dá para mandar mensagem a um bot",
    ratelimited: "limite de mensagens do Slack, tenta de novo em instantes",
  };
  return map[i.code] ?? i.code;
}
