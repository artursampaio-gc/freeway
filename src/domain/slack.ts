import type { DB, Env } from "../env";
import { all, nowIso, one, run } from "../db/q";
import { SLACK_FILES_SCOPE, type SlackErrorInfo, slackConfigured, slackErrorInfo, slackErrorText, slackPost, slackTokenKind, slackUploadImage, slackUserId } from "../integrations/slack";
import { galeriaImage } from "../integrations/galeria";
import { displayPi, SITUACAO_LABEL } from "../shared/labels";
import type { Health } from "../shared/types";
import { devProjects } from "./dev";
import { galeriaByItem } from "./galeria";
import { goproductThumb } from "./goproduct";
import { TEAM_LABEL } from "./steps";
import { loadViews } from "./view";

// Avisos do Freeway também por mensagem direta no Slack, para os mesmos destinatários do app.
// Cada destinatário recebe uma vez (slack_at); só saem avisos novos, nunca o acumulado de antes.

export const APP_URL = "https://freeway.devgogroup.com";
/** Aviso mais velho que isso não vai mais para o Slack (ex.: rotina parada por um tempo). */
const MAX_AGE_MS = 24 * 3600 * 1000;
/** Erros do app ou do token: param a rodada sem marcar nada, para mandar quando o problema for resolvido. */
const FATAL = new Set(["not_authed", "invalid_auth", "token_revoked", "account_inactive", "missing_scope", "not_allowed_token_type", "ratelimited"]);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Pending {
  id: number;
  user_email: string;
  reason: string | null;
  title: string;
  body: string | null;
  process_code: string | null;
  pi_number: string | null;
}

/** Texto cortado no limite, com reticências (nomes de pedido e de lançamento podem ser bem longos). */
export const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const NAME_MAX = 80;
const HEALTH_LABEL: Record<Health, string> = { ok: "No prazo", risk: "Em risco", late: "Atrasado" };
const HEALTH_DOT: Record<Health, string> = { ok: ":large_green_circle:", risk: ":large_orange_circle:", late: ":red_circle:" };

/** O que o cartão do aviso mostra além do título: nome, situação e a foto (já enviada ao Slack). */
export interface SlackCard {
  name: string | null;
  status: string | null;
  health: Health | null;
  /** Id do arquivo da foto no Slack (slack_file). */
  imageId: string | null;
}

/**
 * Aviso como cartão (Block Kit; o Slack não aceita HTML): título e detalhe, a foto ao lado, o pedido ou desenvolvimento
 * com o nome (cortado em 80 caracteres), a situação e o botão "Abrir no Freeway".
 */
export function slackMessage(n: Omit<Pending, "id" | "user_email">, card?: SlackCard | null): { text: string; blocks: unknown[]; noImage: unknown[] } {
  const dev = n.process_code?.startsWith("dev:") ? n.process_code.slice(4) : null;
  const target = n.pi_number ? displayPi(n.pi_number) : n.process_code;
  const link = dev ? `${APP_URL}/#/dev/${dev}` : target ? `${APP_URL}/#/p/${target}` : APP_URL;
  const team = n.reason?.startsWith("time:") ? n.reason.slice(5) : null;
  const why = team ? `Time ${TEAM_LABEL[team] ?? team}` : dev ? "Você segue este desenvolvimento" : "Você segue este pedido";
  const name = card?.name ? cut(card.name, NAME_MAX) : null;
  const body = n.body ? `\n${esc(cut(n.body, 700))}` : "";
  const head: Record<string, unknown> = { type: "section", text: { type: "mrkdwn", text: `*${esc(cut(n.title, 200))}*${body}` } };
  const fields: { type: string; text: string }[] = [];
  if (dev && name) fields.push({ type: "mrkdwn", text: `*Desenvolvimento*\n${esc(name)}` });
  else if (target) fields.push({ type: "mrkdwn", text: `*Pedido*\n${esc(target)}${name ? ` · ${esc(name)}` : ""}` });
  if (card?.status) fields.push({ type: "mrkdwn", text: `*Situação*\n${card.health ? `${HEALTH_DOT[card.health]} ${HEALTH_LABEL[card.health]} · ` : ""}${esc(cut(card.status, 160))}` });
  const rest = [
    ...(fields.length ? [{ type: "section", fields }] : []),
    { type: "actions", elements: [{ type: "button", action_id: "abrir_freeway", style: "primary", text: { type: "plain_text", text: "Abrir no Freeway" }, url: link }] },
    { type: "context", elements: [{ type: "mrkdwn", text: esc(why) }] },
  ];
  const withImage = card?.imageId ? { ...head, accessory: { type: "image", slack_file: { id: card.imageId }, alt_text: cut(name ?? n.title, 120) } } : head;
  return { text: name ? `${n.title} · ${cut(name, 60)}` : n.title, blocks: [withImage, ...rest], noImage: [head, ...rest] };
}

/**
 * Foto da rota do Freeway (/api/goproduct/img/… ou /api/galeria/img/…) enviada uma vez ao Slack. null = essa imagem não
 * deu (não chegou, formato ou tamanho); false = sem a permissão files:write (não adianta tentar outra).
 */
async function slackImageId(db: DB, env: Env, path: string): Promise<string | null | false> {
  const hit = await one<{ file_id: string }>(db, `SELECT file_id FROM slack_images WHERE key = ?`, [path]);
  if (hit) return hit.file_id;
  const off = await setting(db, "slack_files_off");
  if (off && Date.now() - Date.parse(JSON.parse(off).at) < 24 * 3600 * 1000) return false;
  let img: { type: string; bytes: Uint8Array } | null = null;
  const gp = path.match(/^\/api\/goproduct\/img\/(\d+)$/);
  const ga = path.match(/^\/api\/galeria\/img\/([A-Za-z0-9_-]+)(?:\?v=([0-9A-Za-z_-]+))?$/);
  if (gp) img = await goproductThumb(db, env, Number(gp[1]));
  else if (ga) {
    const r = await galeriaImage(env, ga[1], ga[2] ?? null);
    if (r) img = { type: r.headers.get("content-type") ?? "image/jpeg", bytes: new Uint8Array(await r.arrayBuffer()) };
  }
  const ext = img?.type.match(/^image\/(png|jpe?g|gif)/)?.[1];
  if (!img || !ext || img.bytes.length > 4_000_000) return null;
  try {
    const id = await slackUploadImage(env, img.bytes, `freeway-produto.${ext === "jpeg" ? "jpg" : ext}`, "Foto do produto (Freeway)");
    await run(db, `INSERT OR REPLACE INTO slack_images (key, file_id, created_at) VALUES (?, ?, ?)`, [path, id, nowIso()]);
    return id;
  } catch (e) {
    const info = slackErrorInfo(env, e);
    if (info.code === "missing_scope" || info.code === "not_allowed_token_type") {
      await setSetting(db, "slack_files_off", JSON.stringify({ ...info, at: nowIso() }));
      return false;
    }
    console.log(`[slack] foto não enviada (${path}): ${info.code}`);
    return null;
  }
}

/** A primeira foto que der certo, na ordem: Galeria de Lançamentos e, se ela não chegar, a do GoProduct. */
async function firstImageId(db: DB, env: Env, paths: (string | null | undefined)[]): Promise<string | null> {
  for (const p of [...new Set(paths.filter((x): x is string => !!x))]) {
    const id = await slackImageId(db, env, p);
    if (id) return id;
    if (id === false) return null;
  }
  return null;
}

/** Nome, situação e foto do pedido (frete) ou do desenvolvimento do aviso; o que não der para montar fica de fora. */
async function cardFor(db: DB, env: Env, n: Pending, cache: Map<string, SlackCard | null>): Promise<SlackCard | null> {
  const key = n.process_code?.startsWith("dev:") ? n.process_code : n.pi_number ?? n.process_code;
  if (!key) return null;
  if (cache.has(key)) return cache.get(key)!;
  let card: SlackCard | null = null;
  try {
    // Fotos candidatas em ordem: a da Galeria primeiro; se ela não chegar, a do GoProduct.
    let imgs: (string | null | undefined)[] = [];
    if (key.startsWith("dev:")) {
      const [p] = await devProjects(db, key.slice(4));
      if (p) {
        const pk = p.skus.rows.find((r) => r.goproduct_pk)?.goproduct_pk;
        imgs = [p.galeria?.fotos[0], pk ? `/api/goproduct/img/${pk}` : null];
        card = { name: p.info.name.replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, ""), status: p.current, health: p.health, imageId: null };
      }
    } else if (n.process_code) {
      const [v] = await loadViews(db, [n.process_code]);
      const u = v?.units.find((x) => x.unit === n.pi_number) ?? v?.units[0];
      if (v && u) {
        const gal = v.dev ? (await galeriaByItem(db, [v.dev.item_id])).get(v.dev.item_id) : undefined;
        imgs = [gal?.fotos[0], u.items.find((i) => i.goproduct_img)?.goproduct_img, v.items.find((i) => i.goproduct_img)?.goproduct_img];
        const stopped = u.situacao === "cancelado" || u.situacao === "on_hold" || u.situacao === "lancado";
        card = {
          name: u.title ?? v.title ?? u.description ?? v.description ?? (u.products.length ? u.products.slice(0, 3).join(", ") : null),
          status: stopped ? `${SITUACAO_LABEL[u.situacao]}${u.situacao === "lancado" ? "" : ` · ${u.current}`}` : u.current,
          health: stopped ? null : u.health,
          imageId: null,
        };
      }
    }
    if (card) card.imageId = await firstImageId(db, env, imgs);
  } catch (e) {
    console.log(`[slack] cartão sem detalhes (${key}): ${(e as Error).message}`);
  }
  cache.set(key, card);
  return card;
}


/** Id da pessoa no Slack, guardado: quem existe é conferido a cada 30 dias; quem não existe, a cada dia. */
async function slackIdFor(db: DB, env: Env, email: string, cache: Map<string, string | null>, fresh = false): Promise<string | null> {
  if (cache.has(email)) return cache.get(email)!;
  const row = await one<{ slack_id: string | null; checked_at: string }>(db, `SELECT slack_id, checked_at FROM slack_users WHERE email = ?`, [email]);
  const age = row ? Date.now() - Date.parse(row.checked_at) : Infinity;
  let id: string | null;
  if (!fresh && row && age < (row.slack_id ? 30 : 1) * 24 * 3600 * 1000) id = row.slack_id;
  else {
    id = await slackUserId(env, email);
    await run(
      db,
      `INSERT INTO slack_users (email, slack_id, error, checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET slack_id = excluded.slack_id, error = excluded.error, checked_at = excluded.checked_at`,
      [email, id, id ? null : "users_not_found", nowIso()],
    );
  }
  cache.set(email, id);
  return id;
}

async function setting(db: DB, key: string): Promise<string | null> {
  return (await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = ?`, [key]))?.value ?? null;
}
async function setSetting(db: DB, key: string, value: string): Promise<void> {
  await run(db, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
}

/**
 * Manda pelo Slack os avisos ainda não enviados. Roda depois de cada rotina e de cada alteração no app.
 * Na primeira vez marca o início: avisos de antes do Slack ser ligado não saem.
 */
export async function sendSlack(db: DB, env: Env, limit = 40): Promise<{ sent: number; failed: number; stopped?: string; needed?: string; provided?: string } | null> {
  if (!slackConfigured(env)) return null;
  let since = await setting(db, "slack_since");
  if (!since) {
    since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await setSetting(db, "slack_since", since);
  }
  const floor = [since, new Date(Date.now() - MAX_AGE_MS).toISOString()].sort().at(-1)!;
  const rows = await all<Pending>(
    db,
    `SELECT r.notification_id AS id, r.user_email, r.reason, n.title, n.body, n.process_code, n.pi_number
       FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
       LEFT JOIN users u ON u.email = r.user_email
      WHERE r.slack_at IS NULL AND r.read_at IS NULL AND n.created_at >= ? AND COALESCE(u.slack_off, 0) = 0
      ORDER BY n.id LIMIT ?`,
    [floor, limit],
  );
  const out: { sent: number; failed: number; stopped?: string; needed?: string; provided?: string } = { sent: 0, failed: 0 };
  const cache = new Map<string, string | null>();
  const cards = new Map<string, SlackCard | null>();
  const mark = (r: Pending, error: string | null) =>
    run(db, `UPDATE notification_recipients SET slack_at = ?, slack_error = ? WHERE notification_id = ? AND user_email = ?`, [nowIso(), error, r.id, r.user_email]);
  for (const r of rows) {
    try {
      const uid = await slackIdFor(db, env, r.user_email, cache);
      if (!uid) {
        await mark(r, "users_not_found");
        out.failed++;
        continue;
      }
      const m = slackMessage(r, await cardFor(db, env, r, cards));
      await slackPost(env, uid, m.text, m.blocks, m.noImage);
      await mark(r, null);
      out.sent++;
    } catch (e) {
      const info = slackErrorInfo(env, e);
      const code = info.code;
      if (FATAL.has(code)) {
        out.stopped = code;
        if (info.needed) Object.assign(out, { needed: info.needed, provided: info.provided ?? "" });
        await setSetting(db, "slack_last_error", JSON.stringify({ ...info, at: nowIso() }));
        break;
      }
      await mark(r, code);
      out.failed++;
    }
  }
  if (out.sent) await run(db, `DELETE FROM settings WHERE key = 'slack_last_error'`);
  if (out.sent || out.failed || out.stopped) console.log(`[slack] ${JSON.stringify(out)}`);
  return out;
}

/** Mensagem de teste para quem pediu, na tela de Configuração. */
export async function testSlack(db: DB, env: Env, email: string): Promise<{ ok: boolean; error?: string }> {
  if (!slackConfigured(env)) return { ok: false, error: "o Freeway ainda não está ligado ao Slack (falta o token do app)" };
  try {
    const uid = await slackIdFor(db, env, email, new Map(), true);
    if (!uid) return { ok: false, error: `${email} não foi encontrado no Slack` };
    // Teste no formato do cartão, com um pedido que a pessoa segue (se houver), para ver nome, situação e foto.
    // O teste tenta a foto na hora, mesmo que antes tenha faltado a permissão files:write (quem acabou de adicionar confere aqui).
    await run(db, `DELETE FROM settings WHERE key = 'slack_files_off'`);
    const w = await one<{ process_code: string }>(db, `SELECT process_code FROM watchers WHERE user_email = ? ORDER BY created_at DESC LIMIT 1`, [email]);
    const sample: Pending = { id: 0, user_email: email, reason: null, title: "Teste do Freeway: é assim que os avisos chegam", body: "Dá para desligar em Configuração quando quiser.", process_code: w?.process_code ?? null, pi_number: null };
    const m = slackMessage(sample, await cardFor(db, env, sample, new Map()));
    await slackPost(env, uid, m.text, m.blocks, m.noImage);
    await run(db, `DELETE FROM settings WHERE key = 'slack_last_error'`);
    return { ok: true };
  } catch (e) {
    const info = slackErrorInfo(env, e);
    if (FATAL.has(info.code)) await setSetting(db, "slack_last_error", JSON.stringify({ ...info, at: nowIso() }));
    return { ok: false, error: slackErrorText(info) };
  }
}

/** Situação do Slack para a tela: preferência de quem vê e, para admins, o que saiu nos últimos 7 dias. */
export async function slackStatus(db: DB, env: Env, email: string): Promise<Record<string, unknown>> {
  const u = await one<{ slack_off: number | null }>(db, `SELECT slack_off FROM users WHERE email = ?`, [email]);
  const week = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const counts = await one<{ sent: number; failed: number }>(
    db,
    `SELECT COALESCE(SUM(CASE WHEN slack_error IS NULL THEN 1 ELSE 0 END), 0) AS sent, COALESCE(SUM(CASE WHEN slack_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS failed
       FROM notification_recipients WHERE slack_at >= ?`,
    [week],
  );
  const lastFail = await one<{ slack_error: string; user_email: string }>(
    db,
    `SELECT slack_error, user_email FROM notification_recipients WHERE slack_at >= ? AND slack_error IS NOT NULL ORDER BY slack_at DESC LIMIT 1`,
    [week],
  );
  const fatal = await setting(db, "slack_last_error");
  const f = fatal ? (JSON.parse(fatal) as SlackErrorInfo & { at: string }) : null;
  return {
    configured: slackConfigured(env),
    token_kind: slackTokenKind(env),
    on: !u?.slack_off,
    sent_7d: counts?.sent ?? 0,
    failed_7d: counts?.failed ?? 0,
    last_error: lastFail ? `${lastFail.user_email}: ${slackErrorText(lastFail.slack_error)}` : null,
    app_error: f && Date.now() - Date.parse(f.at) < 24 * 3600 * 1000 ? slackErrorText(f) : null,
    // Foto no cartão do aviso: precisa da permissão files:write no app do Slack.
    files_off: (await setting(db, "slack_files_off")) ? `as fotos não vão nos avisos: falta a permissão ${SLACK_FILES_SCOPE} no app do Slack (OAuth & Permissions → Bot Token Scopes, reinstalar o app e gravar o token novo)` : null,
  };
}
