import type { Env } from "./env";
import { all, nowIso, one, run, todayBR } from "./db/q";
import { migrate } from "./db/schema";
import { HttpError, requireOrder, resolveUnit, runAction, setItemCheck, setItemMark, setUnitTitle, updateStep } from "./domain/actions";
import { aiStatus, refreshAi } from "./domain/ai";
import { aiConfigured } from "./integrations/aiproxy";
import { insertEvents, unitLabel } from "./domain/events";
import { runTimeRules } from "./domain/rules";
import { STEPS, TEAM_LABEL } from "./domain/steps";
import { loadViews } from "./domain/view";
import { maybeRefreshFactory } from "./domain/factory";
import { goproductTexture, goproductThumb, maybeRefreshColors, refreshGoProduct, refreshGoProductColors } from "./domain/goproduct";
import { fedexConfigured, refreshFedex, testFedex } from "./integrations/fedex";
import { checkFiscalAccess, fiscalAccess, maybeCheckFiscal, refreshFiscalNotes } from "./integrations/fiscal";
import { mondayConfigured } from "./integrations/monday";
import { setOrderHold } from "./domain/hold";
import { autoWatch, DEV_EDITABLE, devProjects, importSkuList, launchBoards, markWatching, notifyDevChanges, refreshPoLists, refreshWaitlist, setDevWatch, syncLaunchTasks, syncMondayPeople, updateDevStep, validScope, watchedDevIds } from "./domain/dev";
import { refreshItapeva } from "./domain/itapeva";
import { itapevaConfigured } from "./integrations/itapeva";
import { galeriaImage } from "./integrations/galeria";
import { galeriaPhotoKnown, refreshGaleria } from "./domain/galeria";
import { refreshDocs } from "./domain/docs";
import { agendaEvents } from "./domain/agenda";
import { launchGallery } from "./domain/launches";
import { decideSample } from "./domain/samples";
import { chat } from "./domain/chat";
import { dismissUpdates, pendingUpdates, restoreUpdates, syncMonday } from "./domain/monday-sync";
import { refreshProducts } from "./domain/products";
import { sendSlack, slackStatus, testSlack } from "./domain/slack";
import { slackConfigured } from "./integrations/slack";
import { boardList, refreshMonday, selectedBoards, setSelectedBoards } from "./domain/monday";
import { fetchSheetTabs, sheetsConfigured } from "./sheet/google";
import { TABS } from "./sheet/normalize";
import { ingestSheet } from "./sheet/sync";
import { readXlsx } from "./sheet/xlsx";
import type { NextStep, OrderView, UnitView } from "./shared/types";

/** Texto pesquisável de um pedido na lista (processo, PI, fornecedor, frete, situação) e os itens dele. */
function unitSearch(v: OrderView, u: UnitView): { search: string; search_items: string[] } {
  const s = u.shipment;
  const search = [
    u.display, u.process_code, u.pi_number, u.order_kind, u.title, u.description ?? v.description, u.supplier, u.category, v.buyer, v.area,
    ...u.products, s?.status_label, s?.ref_bl, s?.carrier_line, s?.trader, s?.modal, u.current, u.ai_note,
  ].filter(Boolean).join(" ");
  const items = new Set(u.items.map((i) => [i.code, i.name ?? i.product?.sku_unico, i.item_supplier].filter(Boolean).join(" · ")).filter(Boolean));
  return { search, search_items: [...items] };
}

// Dono do app: sempre admin. Outros admins ficam em settings ou no secret ADMIN_EMAILS.
const OWNER = "artur.sampaio@gocase.com";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

async function admins(env: Env): Promise<Set<string>> {
  const row = await one<{ value: string }>(env.DB, `SELECT value FROM settings WHERE key = 'admins'`);
  const list: string[] = row ? JSON.parse(row.value) : [];
  const extra = (env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set([OWNER, ...list, ...extra]);
}

async function requireAdmin(env: Env, user: string): Promise<void> {
  if (!(await admins(env)).has(user)) throw new HttpError(403, "Só administradores podem fazer isso");
}

async function verifyCron(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("x-godeploy-cron");
  if (!header) return false;
  const tsMatch = header.match(/(?:^|;)\s*t=(\d+)/);
  const sigMatch = header.match(/(?:^|;)\s*sig=([0-9a-f]+)/);
  if (!tsMatch || !sigMatch) return false;
  const ts = Number.parseInt(tsMatch[1], 10);
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;
  const key = env.GODEPLOY_CRON_KEY;
  if (!key) return false;
  const url = new URL(request.url);
  const appId = url.hostname.split(".")[0];
  const canonical = JSON.stringify(["v1", appId, request.method.toUpperCase(), url.pathname, ts]);
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sigBytes = new Uint8Array(sigMatch[1].match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", cryptoKey, sigBytes.buffer, enc.encode(canonical));
}

async function handleCron(path: string, env: Env): Promise<Response> {
  if (path === "/cron/planilha") {
    if (!sheetsConfigured(env)) return json({ skipped: "Sheets API não configurada" });
    const tabs = await fetchSheetTabs(env);
    const r = await ingestSheet(env.DB, tabs, "sheets-api");
    const { issues, ...rest } = r;
    console.log(`[planilha] ${JSON.stringify(rest)} issues=${issues.length}`);
    const fiscal = await maybeCheckFiscal(env.DB, env).catch((e) => ({ ok: false, error: (e as Error).message }));
    if (fiscal) console.log(`[fiscal] ${JSON.stringify(fiscal)}`);
    const notas = await refreshFiscalNotes(env.DB, env).catch((e) => ({ erro: (e as Error).message }));
    if (notas) console.log(`[fiscal] notas ${JSON.stringify(notas)}`);
    return json(rest);
  }
  if (path === "/cron/fedex") {
    const r = await refreshFedex(env.DB, env);
    console.log(`[fedex] ${JSON.stringify(r)}`);
    return json(r);
  }
  if (path === "/cron/ia") {
    const r = await refreshAi(env.DB, env);
    console.log(`[ia] rotina ${JSON.stringify(r)}`);
    return json(r);
  }
  if (path === "/cron/monday") {
    const r = await refreshMonday(env.DB, env);
    console.log(`[monday] rotina ${JSON.stringify(r)}`);
    // Trilha de desenvolvimento: tarefas dos lançamentos, nomes das pessoas e quem passa a observar o pedido.
    const erro = (e: unknown) => ({ erro: (e as Error).message.slice(0, 200) });
    const dev = {
      tarefas: await syncLaunchTasks(env.DB, env).catch(erro),
      pessoas: await syncMondayPeople(env.DB, env).catch(erro),
      observadores: await autoWatch(env.DB).catch(erro),
      avisos: await notifyDevChanges(env.DB).catch(erro),
    };
    console.log(`[dev] ${JSON.stringify(dev)}`);
    return json({ ...r, dev });
  }
  if (path === "/cron/goproduct") {
    const r = await refreshGoProduct(env.DB, env);
    r.cores_catalogo = await refreshGoProductColors(env.DB, env).catch((e) => ({ erro: (e as Error).message.slice(0, 200) }));
    // Confere se o token também abre as imagens (elas exigem login no GoProduct).
    const sample = await one<{ pk: number }>(env.DB, `SELECT pk FROM goproduct_parts WHERE thumbnail IS NOT NULL ORDER BY pk LIMIT 1`);
    if (sample) r.teste_imagem = await goproductThumb(env.DB, env, sample.pk).then((x) => (x ? `${x.type} ${x.bytes.length} B` : "sem imagem")).catch((e) => (e as Error).message);
    console.log(`[goproduct] ${JSON.stringify(r)}`);
    return json(r);
  }
  if (path === "/cron/produtos") {
    const r = await refreshProducts(env.DB, env);
    // Planilhas de Waitlist/CTR (trilha de desenvolvimento), de hora em hora junto com os produtos.
    const waitlist = await refreshWaitlist(env.DB, env).catch((e) => ({ erro: (e as Error).message.slice(0, 200) }));
    console.log(`[waitlist] ${JSON.stringify(waitlist)}`);
    // Uma vez: relê o catálogo do GoProduct para trazer a cor de cada produto (antes só às 6h30).
    if (!(await one(env.DB, `SELECT 1 FROM settings WHERE key = 'goproduct_cor_v2'`))) {
      await run(env.DB, `INSERT INTO settings (key, value) VALUES ('goproduct_cor_v2', '"1"') ON CONFLICT(key) DO NOTHING`);
      const gp = await refreshGoProduct(env.DB, env).catch((e) => ({ erro: (e as Error).message.slice(0, 200) }));
      console.log(`[goproduct] cores ${JSON.stringify(gp)}`);
    }
    // Catálogo de cores do GoProduct (pantones e texturas), a cada 12 h.
    const cores = await maybeRefreshColors(env.DB, env).catch((e) => ({ erro: (e as Error).message.slice(0, 200) }));
    if (cores) console.log(`[goproduct] catálogo de cores ${JSON.stringify(cores)}`);
    return json({ ...r, waitlist, cores });
  }
  if (path === "/cron/documentacao") {
    const r = await refreshDocs(env.DB, env);
    console.log(`[docs] rotina ${JSON.stringify(r)}`);
    // Lista de SKUs das POs (.xlsx) que o FileMaker deixa na pasta do pedido.
    const po = await refreshPoLists(env.DB, env).catch((e) => ({ erro: (e as Error).message.slice(0, 200) }));
    console.log(`[po] rotina ${JSON.stringify(po)}`);
    return json({ ...r, po });
  }
  if (path === "/cron/itapeva") {
    const r = await refreshItapeva(env.DB, env);
    console.log(`[itapeva] rotina ${JSON.stringify(r)}`);
    return json(r);
  }
  if (path === "/cron/galeria") {
    const r: Record<string, unknown> = await refreshGaleria(env.DB, env).catch((e) => ({ erro: (e as Error).message.slice(0, 300) }));
    // Confere se a primeira foto abre com a chave (como o teste de imagem do GoProduct).
    const sample = await one<{ data: string }>(env.DB, `SELECT data FROM galeria_launches WHERE instr(data, '/api/galeria/img/') > 0 LIMIT 1`);
    const foto = sample ? (JSON.parse(sample.data).fotos?.[0] as string | undefined) : undefined;
    const fm = foto?.match(/\/api\/galeria\/img\/([A-Za-z0-9_-]+)(?:\?v=([0-9A-Za-z_-]+))?/);
    if (fm) r.teste_foto = await galeriaImage(env, fm[1], fm[2] ?? null).then(async (x) => (x ? `${x.headers.get("content-type")} ${(await x.arrayBuffer()).byteLength} B` : "sem imagem")).catch((e) => (e as Error).message);
    console.log(`[galeria] ${JSON.stringify(r)}`);
    return json(r);
  }
  if (path === "/cron/regras") {
    const n = await runTimeRules(env.DB);
    console.log(`[regras] notificações=${n}`);
    return json({ notifications: n });
  }
  return json({ error: "rota de cron desconhecida" }, 404);
}

/** Envio dos avisos pelo Slack; um erro aqui nunca derruba a rotina ou a alteração. */
async function flushSlack(env: Env, limit: number): Promise<void> {
  if (!slackConfigured(env)) return;
  await sendSlack(env.DB, env, limit).catch((e) => console.log(`[slack] erro: ${(e as Error).message}`));
}

async function myTeams(env: Env, user: string): Promise<string[]> {
  const rows = await all<{ team_key: string }>(env.DB, `SELECT team_key FROM team_members WHERE user_email = ?`, [user]);
  return rows.map((r) => r.team_key);
}

async function api(request: Request, env: Env, user: string, path: string): Promise<Response> {
  const db = env.DB;
  const method = request.method;
  const url = new URL(request.url);
  const body = async () => (await request.json().catch(() => ({}))) as Record<string, any>;
  let m: RegExpMatchArray | null;

  if (path === "/api/me" && method === "GET") {
    const unread = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM notification_recipients WHERE user_email = ? AND read_at IS NULL`, [user]);
    const lastAuto = await one<{ source: string; ran_at: string; ok: number }>(
      db,
      `SELECT source, ran_at, ok FROM sheet_syncs WHERE source = 'sheets-api' ORDER BY id DESC LIMIT 1`,
    );
    return json({
      lastAutoSync: lastAuto,
      email: user,
      isAdmin: (await admins(env)).has(user),
      teams: await myTeams(env, user),
      unread: unread?.n ?? 0,
      steps: STEPS,
      teamLabels: TEAM_LABEL,
      integrations: { sheets: sheetsConfigured(env), fedex: fedexConfigured(env), ai: aiConfigured(env), monday: mondayConfigured(env), itapeva: itapevaConfigured(env), slack: slackConfigured(env) },
    });
  }

  // Slack: preferência de cada pessoa, mensagem de teste e o que saiu nos últimos 7 dias.
  if (path === "/api/slack" && method === "GET") {
    return json(await slackStatus(db, env, user));
  }
  if (path === "/api/slack" && method === "POST") {
    const on = (await body()).on !== false;
    await run(db, `UPDATE users SET slack_off = ? WHERE email = ?`, [on ? null : 1, user]);
    return json({ ok: true, on });
  }
  if (path === "/api/slack/test" && method === "POST") {
    const r = await testSlack(db, env, user);
    if (!r.ok) throw new HttpError(400, `Não deu para mandar: ${r.error}`);
    return json(r);
  }

  // Base da fábrica (cadastro e estoque em Extrema): só dá para ler com o login de quem usa o app.
  // O app chama em segundo plano a cada navegação; lê de fato no máximo a cada 30 minutos.
  if (path === "/api/factory/refresh" && method === "POST") {
    return json((await maybeRefreshFactory(db, env, request.headers.get("Cookie"))) ?? { skipped: true });
  }

  // Miniatura do produto no GoProduct (guardada no banco; o GoProduct só entrega imagem com login).
  if ((m = path.match(/^\/api\/goproduct\/img\/(\d+)$/)) && method === "GET") {
    const img = await goproductThumb(db, env, Number(m[1])).catch((e) => {
      console.log(`[goproduct] imagem ${m![1]}: ${(e as Error).message}`);
      return null;
    });
    if (!img) return new Response("sem imagem", { status: 404, headers: { "Cache-Control": "private, max-age=3600" } });
    return new Response(img.bytes as unknown as BodyInit, { headers: { "Content-Type": img.type, "Cache-Control": "private, max-age=86400" } });
  }

  // Textura de uma cor do GoProduct (guardada no banco; o GoProduct só entrega imagem com login).
  if ((m = path.match(/^\/api\/goproduct\/cor\/(\d+)\/textura$/)) && method === "GET") {
    const img = await goproductTexture(db, env, Number(m[1])).catch((e) => {
      console.log(`[goproduct] textura ${m![1]}: ${(e as Error).message}`);
      return null;
    });
    if (!img) return new Response("sem textura", { status: 404, headers: { "Cache-Control": "private, max-age=3600" } });
    return new Response(img.bytes as unknown as BodyInit, { headers: { "Content-Type": img.type, "Cache-Control": "private, max-age=86400" } });
  }

  // Foto de um lançamento da Galeria de Lançamentos (buscada com a chave; só as que a Galeria lista).
  if ((m = path.match(/^\/api\/galeria\/img\/([A-Za-z0-9_-]{5,200})$/)) && method === "GET") {
    const img = (await galeriaPhotoKnown(db, m[1])) ? await galeriaImage(env, m[1], url.searchParams.get("v")).catch(() => null) : null;
    if (!img) return new Response("sem imagem", { status: 404, headers: { "Cache-Control": "private, max-age=3600" } });
    return new Response(img.body, { headers: { "Content-Type": img.headers.get("content-type") ?? "image/png", "Cache-Control": "private, max-age=604800" } });
  }

  if (path === "/api/home" && method === "GET") {
    const watched = await all<{ process_code: string }>(db, `SELECT process_code FROM watchers WHERE user_email = ? ORDER BY created_at DESC`, [user]);
    const views = await loadViews(db, watched.map((w) => w.process_code), user);
    const teams = await myTeams(env, user);
    const allSteps = (v: OrderView): NextStep[] => v.units.flatMap((u) => u.next_steps);
    const mine: NextStep[] = views.flatMap(allSteps).filter((n) => !n.team || teams.includes(n.team));
    let teamSteps: NextStep[] = [];
    if (teams.length) {
      const watchedSet = new Set(watched.map((w) => w.process_code));
      const active = await all<{ process_code: string }>(db, `SELECT DISTINCT process_code FROM watchers`);
      const others = active.map((a) => a.process_code).filter((c) => !watchedSet.has(c));
      const otherViews = await loadViews(db, others, user);
      teamSteps = otherViews.flatMap(allSteps).filter((n) => n.team && teams.includes(n.team));
    }
    // Cada frete de um pedido dividido é um pedido próprio na lista; os itens ficam para a página dele,
    // e aqui vão só como texto para a busca de Minhas Observações.
    const units = views.flatMap((v) => v.units.map((u) => ({ ...u, items: [], ...unitSearch(v, u) })));
    // Desenvolvimentos observados; o que já virou um pedido observado aparece só como pedido.
    const watchedCodes = new Set(watched.map((w) => w.process_code));
    const devs = (await devProjects(db, await watchedDevIds(db, user)))
      .filter((p) => !p.info.process_codes.some((c) => watchedCodes.has(c)))
      .map((p) => ({ ...p, watching: true }));
    return json({ units, devs, myNextSteps: mine, teamNextSteps: teamSteps });
  }

  if (path === "/api/search" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim();
    // andamento = ainda não lançado no site (o "Finalizada" da planilha é só a importação); todos = tudo.
    const filtro = url.searchParams.get("filtro") === "todos" ? "todos" : "andamento";
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const launched = `json_extract(ss.data, '$.done_at') IS NOT NULL`;
    const rows = await all(
      db,
      `SELECT o.process_code, o.kind, o.description, (SELECT t.title FROM unit_titles t WHERE t.unit = o.process_code) AS title, o.supplier, o.category, o.po_status, o.production_status, o.po_date,
              (SELECT COUNT(*) FROM shipments s WHERE s.process_code = o.process_code AND s.removed_at IS NULL) AS shipments,
              EXISTS (SELECT 1 FROM watchers w WHERE w.process_code = o.process_code AND w.user_email = ?) AS watching,
              (SELECT h.state FROM order_hold h WHERE h.process_code = o.process_code) AS hold
         FROM orders o
        WHERE o.removed_at IS NULL
          AND (? = 'todos' OR (
                COALESCE(o.po_status, '') <> 'Cancelada'
                AND NOT EXISTS (SELECT 1 FROM order_hold h WHERE h.process_code = o.process_code AND h.state = 'cancelado')
                AND NOT EXISTS (SELECT 1 FROM step_state ss WHERE ss.scope = o.process_code AND ss.step_key = 'lancamento' AND ${launched})
                AND NOT (
                  EXISTS (SELECT 1 FROM shipments s WHERE s.process_code = o.process_code AND s.removed_at IS NULL)
                  AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.process_code = o.process_code AND s.removed_at IS NULL
                    AND NOT EXISTS (SELECT 1 FROM step_state ss WHERE ss.scope = s.pi_number AND ss.step_key = 'lancamento' AND ${launched}))
                )))
          AND (? = '' OR o.process_code LIKE ? OR o.description LIKE ? OR o.supplier LIKE ?
               OR EXISTS (SELECT 1 FROM unit_titles t WHERE t.process_code = o.process_code AND t.title LIKE ?)
               OR EXISTS (SELECT 1 FROM order_items i WHERE i.process_code = o.process_code AND (i.sku LIKE ? OR i.sku_code LIKE ? OR i.item_supplier LIKE ?)))
        ORDER BY (o.po_status = 'Aberta') DESC, o.po_date DESC, o.process_code DESC
        LIMIT 60`,
      [user, filtro, q, like, like, like, like, like, like, like],
    );
    return json({ results: rows });
  }

  if (path === "/api/process" && method === "POST") {
    const b = await body();
    const code = String(b.process_code ?? "").trim().toUpperCase();
    if (!/^(GOC|BBI)\d{5}$/.test(code)) throw new HttpError(400, "Use o formato GOC12345 ou BBI12345");
    if (await one(db, `SELECT 1 FROM orders WHERE process_code = ?`, [code])) throw new HttpError(409, `${code} já existe`);
    await run(
      db,
      `INSERT INTO orders (process_code, kind, description, supplier, po_status, source, updated_at) VALUES (?, ?, ?, ?, 'Aberta', 'manual', ?)`,
      [code, code.slice(0, 3), b.description ? String(b.description).slice(0, 300) : null, b.supplier ? String(b.supplier).slice(0, 200) : null, nowIso()],
    );
    await run(db, `INSERT OR IGNORE INTO watchers (process_code, user_email, created_at) VALUES (?, ?, ?)`, [code, user, nowIso()]);
    await insertEvents(db, [{ process_code: code, type: "criado", message: "Pedido criado manualmente no Freeway", actor: user }]);
    return json({ ok: true, process_code: code });
  }

  // Cancelar, deixar on hold ou reativar o pedido (state null). Vale para o pedido todo.
  if ((m = path.match(/^\/api\/process\/((?:GOC|BBI)\d{5})\/hold$/)) && method === "PUT") {
    const code = m[1];
    if (!(await one(db, `SELECT 1 FROM orders WHERE process_code = ?`, [code]))) throw new HttpError(404, `Processo ${code} não encontrado`);
    const b = await body();
    const state = b.state === "cancelado" || b.state === "on_hold" ? b.state : null;
    return json({ ok: true, changed: await setOrderHold(db, code, state, b.note ? String(b.note) : null, user) });
  }

  if ((m = path.match(/^\/api\/process\/((?:GOC|BBI)\d{5})$/)) && method === "GET") {
    const code = m[1];
    const [view] = await loadViews(db, [code], user);
    if (!view) throw new HttpError(404, `Processo ${code} não encontrado`);
    const events = await all(db, `SELECT id, pi_number, step_key, type, message, actor, created_at FROM events WHERE process_code = ? ORDER BY id DESC LIMIT 200`, [code]);
    const documents = await all(db, `SELECT id, kind, unit, filename, size, uploaded_by, uploaded_at FROM documents WHERE process_code = ? ORDER BY id DESC`, [code]);
    return json({ order: view, events, documents });
  }

  if ((m = path.match(/^\/api\/process\/((?:GOC|BBI)\d{5})\/watch$/))) {
    const code = m[1];
    await requireOrder(db, code);
    if (method === "POST") {
      await run(db, `INSERT OR IGNORE INTO watchers (process_code, user_email, created_at) VALUES (?, ?, ?)`, [code, user, nowIso()]);
      await runTimeRules(db, [code]);
    } else if (method === "DELETE") {
      await run(db, `DELETE FROM watchers WHERE process_code = ? AND user_email = ?`, [code, user]);
    }
    return json({ ok: true });
  }

  if ((m = path.match(/^\/api\/process\/((?:GOC|BBI)\d{5})\/ia$/)) && method === "POST") {
    await requireOrder(db, m[1]);
    const b = await body();
    const r = await refreshAi(db, env, [m[1]], { force: !!b.force, max: 1 });
    const row = await one(db, `SELECT error FROM ai_insights WHERE process_code = ?`, [m[1]]);
    return json({ ...r, error: row?.error ?? null });
  }

  // Etapa de um processo: o pedido (BBI25205) ou um embarque (BBI25205.2 / BBI25205-2).
  if ((m = path.match(/^\/api\/unit\/((?:GOC|BBI)\d{5}(?:[.-]\d+)?)\/step\/(\w+)$/)) && method === "PATCH") {
    await updateStep(db, m[1], m[2], await body(), user);
    return json({ ok: true });
  }

  // Galeria: lançamentos abertos agrupados pelo mês de lançamento do Monday, com foto e linhas de status.
  if (path === "/api/lancamentos" && method === "GET") {
    return json(await launchGallery(db, user));
  }

  // Agenda: datas dos pedidos em andamento (e dos seguidos) e tarefas dos desenvolvimentos abertos.
  if (path === "/api/agenda" && method === "GET") {
    return json(await agendaEvents(db, user, url.searchParams.get("from"), url.searchParams.get("to")));
  }

  // Desenvolvimento: lançamentos abertos dos quadros Launches (Monday), com a trilha e a lista de SKUs.
  if (path === "/api/dev" && method === "GET") {
    return json({ projects: await markWatching(db, await devProjects(db), user), boards: (await launchBoards(db)).map((b) => b.name) });
  }
  if ((m = path.match(/^\/api\/dev\/(\d+)$/)) && method === "GET") {
    const [project] = await devProjects(db, m[1]);
    if (!project) throw new HttpError(404, "Lançamento não encontrado");
    await markWatching(db, [project], user);
    return json({ project });
  }
  if ((m = path.match(/^\/api\/dev\/(\d+)\/watch$/)) && (method === "POST" || method === "DELETE")) {
    await setDevWatch(db, m[1], user, method === "POST").catch((e) => {
      throw new HttpError(404, (e as Error).message);
    });
    return json({ ok: true });
  }

  // Marcação no app de CTR, Waitlist, Cores e Fabricação (concluir, rodar de novo, prazo, link, cores…).
  if ((m = path.match(/^\/api\/dev-step\/((?:GOC|BBI)\d{5}|dev:\d+)\/(\w+)$/)) && method === "PATCH") {
    if (!DEV_EDITABLE.includes(m[2])) throw new HttpError(400, "Etapa não editável");
    const data = await updateDevStep(db, m[1], m[2], await body(), user).catch((e) => {
      throw new HttpError(400, (e as Error).message);
    });
    return json({ ok: true, data });
  }

  // Lista de SKUs temporária (à mão ou lida pela IA), até a PO do FileMaker chegar.
  if (path === "/api/skus" && method === "POST") {
    const b = await body();
    const scope = String(b.scope ?? "");
    if (!validScope(scope)) throw new HttpError(400, "Lista inválida");
    const code = String(b.code ?? "").replace(/\s+/g, "").toUpperCase().slice(0, 40) || null;
    const name = String(b.name ?? "").trim().slice(0, 200) || null;
    if (!code && !name) throw new HttpError(400, "Informe o código ou o nome do SKU");
    const qty = Number(b.qty) > 0 ? Number(b.qty) : null;
    await run(db, `INSERT INTO sku_lists (scope, code, name, qty, source, created_by, created_at) VALUES (?, ?, ?, ?, 'manual', ?, ?)`, [scope, code, name, qty, user, nowIso()]);
    return json({ ok: true });
  }
  if (path === "/api/skus/import" && method === "POST") {
    const b = await body();
    const scope = String(b.scope ?? "");
    if (!validScope(scope)) throw new HttpError(400, "Lista inválida");
    if (b.file_b64 && String(b.file_b64).length > 4_200_000) throw new HttpError(400, "O arquivo precisa ter até 3 MB");
    const input = {
      text: b.text ? String(b.text).slice(0, 100_000) : undefined,
      file_b64: b.file_b64 ? String(b.file_b64) : undefined,
      filename: b.filename ? String(b.filename).slice(0, 200) : undefined,
      mime: b.mime ? String(b.mime).slice(0, 100) : undefined,
    };
    if (!input.text && !input.file_b64) throw new HttpError(400, "Cole a lista ou escolha um arquivo");
    const r = await importSkuList(db, env, scope, input, user).catch((e) => {
      throw new HttpError(400, (e as Error).message.slice(0, 300));
    });
    return json({ ok: true, ...r });
  }
  if ((m = path.match(/^\/api\/skus\/(\d+)$/)) && method === "DELETE") {
    await run(db, `DELETE FROM sku_lists WHERE id = ? AND source IN ('manual', 'lista')`, [Number(m[1])]);
    return json({ ok: true });
  }

  // Título dado no app (vazio volta ao da planilha).
  if ((m = path.match(/^\/api\/unit\/((?:GOC|BBI)\d{5}(?:[.-]\d+)?)\/title$/)) && method === "PUT") {
    const b = await body();
    return json({ ok: true, title: await setUnitTitle(db, m[1], b.title, user) });
  }

  // Ação de um clique num pedido ou frete (BBI25205, BBI25205.2 ou BBI25205-2).
  if ((m = path.match(/^\/api\/unit\/((?:GOC|BBI)\d{5}(?:[.-]\d+)?)\/action\/(\w+)$/)) && method === "POST") {
    await runAction(db, m[1], m[2], user);
    return json({ ok: true });
  }

  // Atualizações do pedido para o Monday: prévia e sincronização manual.
  if ((m = path.match(/^\/api\/process\/((?:GOC|BBI)\d{5})\/monday$/)) && method === "GET") {
    if (!mondayConfigured(env)) return json({ configured: false, items: 0, updates: [], dismissed: [] });
    const { items, updates, dismissed, live } = await pendingUpdates(db, env, m[1], user);
    return json({ configured: true, items, updates, dismissed, live });
  }
  if ((m = path.match(/^\/api\/process\/((?:GOC|BBI)\d{5})\/monday\/sync$/)) && method === "POST") {
    const b = await body();
    if (!Array.isArray(b.items) || !b.items.length) throw new HttpError(400, "Escolha o que sincronizar");
    const picks = b.items.map((i: any) => ({ id: String(i.id), from: i.from === null || i.from === undefined ? null : String(i.from) }));
    return json(await syncMonday(db, env, m[1], picks, user));
  }
  // X numa sugestão: interpretação errada, não sugerir de novo enquanto for a mesma.
  if ((m = path.match(/^\/api\/process\/((?:GOC|BBI)\d{5})\/monday\/dismiss$/)) && method === "POST") {
    const b = await body();
    if (!Array.isArray(b.items) || !b.items.length) throw new HttpError(400, "Nada a marcar");
    const list = b.items.slice(0, 200).map((i: any) => ({ id: String(i.id), to: String(i.to ?? ""), why: String(i.why ?? ""), label: String(i.label ?? i.id).slice(0, 300) }));
    return json({ ok: true, marcadas: await dismissUpdates(db, m[1], list, user) });
  }
  if ((m = path.match(/^\/api\/process\/((?:GOC|BBI)\d{5})\/monday\/restore$/)) && method === "POST") {
    const b = await body();
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, 200).map(String) : [];
    return json({ ok: true, voltaram: await restoreUpdates(db, m[1], ids) });
  }

  // Perguntas sobre os dados para a IA (aba Perguntar).
  if (path === "/api/chat" && method === "POST") {
    if (!aiConfigured(env)) throw new HttpError(400, "A IA ainda não está configurada");
    const b = await body();
    try {
      return json(await chat(db, env, user, Array.isArray(b.messages) ? b.messages : []));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      console.log(`[chat] erro: ${(err as Error).message}`);
      throw new HttpError(502, "A IA não respondeu agora. Tente de novo em instantes.");
    }
  }

  // Amostra do Monday: confirmar (ok) ou descartar a ligação com um pedido.
  if (path === "/api/sample-link" && method === "POST") {
    const b = await body();
    const code = String(b.process_code ?? "");
    await requireOrder(db, code);
    await decideSample(db, String(b.item_id ?? ""), code, !!b.ok, user);
    return json({ ok: true });
  }

  if (path === "/api/item-mark" && method === "POST") {
    const b = await body();
    await setItemMark(db, String(b.id ?? ""), String(b.kind ?? ""), !!b.done, user);
    return json({ ok: true });
  }

  if (path === "/api/item-check" && method === "POST") {
    const b = await body();
    await setItemCheck(db, String(b.id ?? ""), !!b.done, user);
    return json({ ok: true });
  }

  if ((m = path.match(/^\/api\/process\/((?:GOC|BBI)\d{5})\/documents$/)) && method === "POST") {
    const code = m[1];
    const b = await body();
    // O documento pode ser do pedido inteiro ou de um embarque.
    const { pi, freights } = await resolveUnit(db, String(b.unit ?? code));
    const content = String(b.content_b64 ?? "");
    const size = Math.floor((content.length * 3) / 4);
    if (!content || size > 1_500_000) throw new HttpError(400, "Arquivo vazio ou maior que 1,5 MB");
    const kind = b.kind === "fci" ? "fci" : "outro";
    const filename = String(b.filename ?? "documento.pdf").slice(0, 200);
    await run(db, `INSERT INTO documents (process_code, unit, kind, filename, mime, size, content_b64, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      code, pi ?? code, kind, filename, String(b.mime ?? "application/pdf").slice(0, 100), size, content, user, nowIso(),
    ]);
    if (kind === "fci") {
      const doc = await one<{ id: number }>(db, `SELECT MAX(id) AS id FROM documents WHERE process_code = ?`, [code]);
      await updateStep(db, pi ?? code, "fci", { done_at: todayBR() }, user);
      await insertEvents(db, [{ process_code: code, pi_number: pi, step_key: "fci", type: "documento", message: `${unitLabel(code, pi, freights)}: PDF da FCI anexado (${filename})`, new_value: String(doc?.id ?? ""), actor: user }]);
    }
    return json({ ok: true });
  }

  if ((m = path.match(/^\/api\/documents\/(\d+)$/)) && method === "GET") {
    const doc = await one(db, `SELECT filename, mime, content_b64 FROM documents WHERE id = ?`, [Number(m[1])]);
    if (!doc) throw new HttpError(404, "Documento não encontrado");
    const bytes = Uint8Array.from(atob(doc.content_b64), (c) => c.charCodeAt(0));
    return new Response(bytes, {
      headers: { "Content-Type": doc.mime || "application/pdf", "Content-Disposition": `inline; filename="${String(doc.filename).replace(/"/g, "")}"` },
    });
  }

  if (path === "/api/notifications" && method === "GET") {
    const rows = await all(
      db,
      `SELECT n.id, n.process_code, n.pi_number, n.kind, n.title, n.body, n.created_at, r.read_at, r.reason
         FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
        WHERE r.user_email = ? ORDER BY n.id DESC LIMIT 100`,
      [user],
    );
    return json({ notifications: rows });
  }

  if (path === "/api/notifications/read" && method === "POST") {
    const b = await body();
    if (Array.isArray(b.ids) && b.ids.length) {
      await run(db, `UPDATE notification_recipients SET read_at = ? WHERE user_email = ? AND read_at IS NULL AND notification_id IN (SELECT value FROM json_each(?))`, [
        nowIso(), user, JSON.stringify(b.ids.map(Number)),
      ]);
    } else {
      await run(db, `UPDATE notification_recipients SET read_at = ? WHERE user_email = ? AND read_at IS NULL`, [nowIso(), user]);
    }
    return json({ ok: true });
  }

  if (path === "/api/teams" && method === "GET") {
    const teams = await all(db, `SELECT key, name FROM teams ORDER BY name`);
    const members = await all(db, `SELECT team_key, user_email FROM team_members ORDER BY user_email`);
    return json({ teams: teams.map((t) => ({ ...t, members: members.filter((x) => x.team_key === t.key).map((x) => x.user_email) })) });
  }

  if ((m = path.match(/^\/api\/teams\/(\w+)\/members$/))) {
    await requireAdmin(env, user);
    const b = await body();
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "E-mail inválido");
    if (!(await one(db, `SELECT 1 FROM teams WHERE key = ?`, [m[1]]))) throw new HttpError(404, "Time não encontrado");
    if (method === "POST") await run(db, `INSERT OR IGNORE INTO team_members (team_key, user_email) VALUES (?, ?)`, [m[1], email]);
    else if (method === "DELETE") await run(db, `DELETE FROM team_members WHERE team_key = ? AND user_email = ?`, [m[1], email]);
    return json({ ok: true });
  }

  if (path === "/api/admin/fedex/test" && method === "POST") {
    await requireAdmin(env, user);
    const r = await testFedex(db, env);
    console.log("[fedex] teste " + JSON.stringify(r));
    return json(r);
  }

  if (path === "/api/admin/fiscal/check" && method === "POST") {
    await requireAdmin(env, user);
    const r = await checkFiscalAccess(db, env);
    console.log("[fiscal] teste " + JSON.stringify(r));
    if (r.ok) {
      const notas = await refreshFiscalNotes(db, env).catch((e) => ({ erro: (e as Error).message }));
      console.log(`[fiscal] notas ${JSON.stringify(notas)}`);
      if (notas && "ligados" in notas) r.linked = notas.ligados;
    }
    return json(r);
  }

  if (path === "/api/admin/status" && method === "GET") {
    await requireAdmin(env, user);
    const syncs = await all(db, `SELECT id, source, ran_at, ok, summary FROM sheet_syncs ORDER BY id DESC LIMIT 20`);
    const lastIssues = await one<{ issues: string }>(db, `SELECT issues FROM sheet_syncs ORDER BY id DESC LIMIT 1`);
    const counts = await one(db, `SELECT
      (SELECT COUNT(*) FROM orders WHERE removed_at IS NULL) AS processos,
      (SELECT COUNT(*) FROM orders WHERE removed_at IS NULL AND po_status = 'Aberta') AS abertos,
      (SELECT COUNT(*) FROM shipments WHERE removed_at IS NULL) AS embarques,
      (SELECT COUNT(DISTINCT process_code) FROM watchers) AS ativos`);
    return json({
      syncs: syncs.map((s) => ({ ...s, summary: JSON.parse(s.summary ?? "{}") })),
      issues: JSON.parse(lastIssues?.issues ?? "[]"),
      counts,
      admins: [...(await admins(env))],
      integrations: { sheets: sheetsConfigured(env), fedex: fedexConfigured(env), ai: aiConfigured(env) },
      ai: await aiStatus(db),
      fiscal: await fiscalAccess(db),
    });
  }

  if (path === "/api/admin/admins" && (method === "POST" || method === "DELETE")) {
    await requireAdmin(env, user);
    const email = String((await body()).email ?? "").trim().toLowerCase();
    const row = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'admins'`);
    const list = new Set<string>(row ? JSON.parse(row.value) : []);
    if (method === "POST") list.add(email);
    else list.delete(email);
    await run(db, `INSERT INTO settings (key, value) VALUES ('admins', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify([...list])]);
    return json({ ok: true });
  }

  // Quadros do Monday: lista o que o token enxerga e guarda os escolhidos para a sincronização.
  if (path === "/api/admin/monday/boards" && (method === "GET" || method === "PUT")) {
    await requireAdmin(env, user);
    if (!mondayConfigured(env)) throw new HttpError(400, "Falta o secret MONDAY_TOKEN");
    if (method === "PUT") {
      const ids = (await body()).ids;
      if (!Array.isArray(ids)) throw new HttpError(400, "Envie ids: [...]");
      return json({ selected: await setSelectedBoards(db, env, ids) });
    }
    const list = await boardList(db, env, url.searchParams.get("refresh") === "1");
    return json({ ...list, selected: await selectedBoards(db) });
  }

  if (path === "/api/admin/import-xlsx" && method === "POST") {
    await requireAdmin(env, user);
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.length < 100) throw new HttpError(400, "Arquivo vazio");
    const tabs = await readXlsx(buf, Object.values(TABS));
    const r = await ingestSheet(db, tabs, `upload:${user}`);
    return json({ ...r, issues: r.issues.slice(0, 100), issuesTotal: r.issues.length });
  }

  if (path === "/api/admin/sync-now" && method === "POST") {
    await requireAdmin(env, user);
    if (!sheetsConfigured(env)) throw new HttpError(400, "A leitura automática da planilha ainda não está configurada");
    const r = await ingestSheet(db, await fetchSheetTabs(env), `manual:${user}`);
    return json({ ...r, issues: r.issues.slice(0, 100), issuesTotal: r.issues.length });
  }

  throw new HttpError(404, "Rota não encontrada");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const reqId = request.headers.get("x-godeploy-request-id");
    try {
      await migrate(env.DB);
      if (path.startsWith("/cron/")) {
        if (request.method !== "POST" || !(await verifyCron(request, env))) return new Response("forbidden", { status: 403 });
        const res = await handleCron(path, env);
        await flushSlack(env, 40);
        return res;
      }
      if (path.startsWith("/api/")) {
        const user = request.headers.get("x-godeploy-user-email")?.toLowerCase();
        if (!user) return json({ error: "Faça login" }, 401);
        await run(env.DB, `INSERT INTO users (email, first_seen_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at`, [user, nowIso(), nowIso()]);
        if (path === "/api/client-error" && request.method === "POST") {
          console.log(`[client-error] reqId=${reqId} user=${user} ${(await request.text()).slice(0, 2000)}`);
          return json({ ok: true });
        }
        const res = await api(request, env, user, path);
        // Avisos criados por esta alteração saem no Slack na hora (o resto, na próxima rotina).
        if (request.method !== "GET") await flushSlack(env, 10);
        return res;
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.log(`[erro] reqId=${reqId} ${request.method} ${path}: ${(err as Error).stack ?? err}`);
      return json({ error: "Erro interno. Tente de novo." }, 500);
    }
  },
};
