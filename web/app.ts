import { render, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { NotificationView } from "../src/shared/types";
import { displayPi, fmtDate, IMPORT_STATUS_LABEL, PRODUCTION_STATUS_LABEL } from "../src/shared/labels";
import { api, attempt, Empty, html, linkify, type Me, toast, Toast, useHash, utcToBr, when } from "./core";
import { Icon, IconBtn, type IconName } from "./icons";
import { Home, ProcessRoute } from "./process";
import { DevList, DevRoute } from "./dev";
import { AgendaPage } from "./agenda";
import { LaunchGallery } from "./launches";

/** Situação da leitura automática da planilha (Sheets API, a cada 30 min). */
function autoSyncText(me: Me): { on: boolean; text: string } {
  const last = me.lastAutoSync;
  const at = last ? `${fmtDate(last.ran_at.slice(0, 10), true)} às ${utcToBr(last.ran_at)}` : "";
  if (!me.integrations.sheets) return { on: false, text: "Não configurada" };
  if (last && !last.ok) return { on: false, text: `Falhou na última leitura (${at})` };
  return { on: true, text: `Ligada, a cada 30 minutos${at ? ` · última leitura ${at}` : " · aguardando a primeira leitura"}` };
}

// ---------- Cabeçalho ----------

function Header({ me, hash }: { me: Me | null; hash: string }) {
  // Cada aba com o seu ícone; "ai" é o ícone da IA (o mesmo das leituras da IA).
  const tab = (href: string, label: string, icon: IconName | "ai") =>
    html`<a href=${href} class=${hash === href || (href !== "#/" && hash.startsWith(href)) ? "on" : ""}>${icon === "ai" ? html`<span class="ai-icon" aria-hidden="true"></span>` : html`<${Icon} name=${icon} />`}<span>${label}</span></a>`;
  return html`<header class="top"><div class="inner">
    <a class="brand" href="#/" aria-label="Freeway, início"><span class="wordmark" role="img" aria-label="Freeway"></span></a>
    <nav class="tabs">
      ${tab("#/", "Seguindo", "pin")}
      ${tab("#/buscar", "Pedidos", "flag")}
      ${tab("#/dev", "Desenvolvimentos", "bulb")}
      ${tab("#/galeria", "Galeria", "star")}
      ${tab("#/agenda", "Agenda", "calendar")}
      ${tab("#/perguntar", "Perguntar", "ai")}
      ${tab("#/config", "Configuração", "gear")}
    </nav>
    <span class="spacer"></span>
    <a class="bell" href="#/notificacoes" aria-label="Notificações" data-tip="Notificações">
      <button class="icon-btn ghost" tabindex="-1" aria-hidden="true"><${Icon} name="bell" /></button>
      ${me && me.unread > 0 && html`<span class="badge">${me.unread > 99 ? "99+" : me.unread}</span>`}
    </a>
    <span class="faint small">${me?.email ?? ""}</span>
  </div></header>`;
}

// ---------- Busca ----------

function Search({ onChange }: { onChange: () => void }) {
  const [q, setQ] = useState("");
  const [filtro, setFiltro] = useState("andamento");
  const [rows, setRows] = useState<any[] | null>(null);
  const [creating, setCreating] = useState(false);
  const timer = useRef<number>();
  const load = (query: string, f: string) =>
    api("GET", `/api/search?q=${encodeURIComponent(query)}&filtro=${f}`).then((d) => setRows(d.results)).catch((e) => toast(e.message, true));
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => load(q, filtro), 250);
  }, [q, filtro]);
  const toggle = async (r: any) => {
    const ok = await attempt(() => api(r.watching ? "DELETE" : "POST", `/api/process/${r.process_code}/watch`), r.watching ? `Você deixou de seguir ${r.process_code}` : `Seguindo ${r.process_code}`);
    if (ok) {
      load(q, filtro);
      onChange();
    }
  };
  return html`<div>
    <h1>Pedidos</h1>
    <p class="muted">Busque na planilha de importação e siga o pedido. Ele passa a aparecer em Seguindo; se for dividido em mais de um frete, cada frete aparece como um pedido próprio.</p>
    <div class="card">
      <div class="row">
        <input style=${{ flex: 1, minWidth: "220px" }} placeholder="BBI25205, TX221004, garrafa, Everich…" value=${q} onInput=${(e: any) => setQ(e.target.value)} autofocus />
        <select value=${filtro} onChange=${(e: any) => setFiltro(e.target.value)} aria-label="Filtro">
          <option value="andamento">Em andamento (não lançados)</option>
          <option value="todos">Todos</option>
        </select>
      </div>
      <div style=${{ marginTop: "8px" }}>
        ${rows === null
          ? html`<div class="loading">Buscando…</div>`
          : rows.length === 0
            ? html`<div class="empty"><p>Nenhum processo encontrado.</p></div>`
            : rows.map(
                (r) => html`<div class="list-row">
                  <a class="mono" href=${`#/p/${r.process_code}`}><b>${r.process_code}</b></a>
                  ${r.hold && html`<span class=${"chip " + (r.hold === "cancelado" ? "late" : "risk")}>${r.hold === "cancelado" ? "Cancelado" : "On hold"}</span>`}
                  <div style=${{ flex: 1, minWidth: 0 }}>
                    <div style=${{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${r.title ?? r.description ?? "Sem descrição"}</div>
                    <div class="small faint">${[r.supplier, r.category, r.po_status && (IMPORT_STATUS_LABEL[r.po_status] ?? r.po_status), r.production_status && `produção ${PRODUCTION_STATUS_LABEL[r.production_status]?.toLowerCase()}`, r.shipments > 1 ? `dividido em ${r.shipments} fretes` : null].filter(Boolean).join(" · ")}</div>
                  </div>
                  <${IconBtn} icon="pin" filled=${!!r.watching} variant=${r.watching ? "on" : ""} tip=${r.watching ? "Seguindo. Clique para deixar de seguir" : "Seguir este pedido"} onClick=${() => toggle(r)} />
                </div>`,
              )}
      </div>
    </div>
    <div class="section card">
      <div class="row"><h2 style=${{ margin: 0 }}>Pedido que ainda não está na planilha</h2><span class="spacer"></span>
        ${creating
          ? html`<${IconBtn} icon="x" tip="Cancelar" onClick=${() => setCreating(false)} />`
          : html`<button class="small with-icon" onClick=${() => setCreating(true)}><${Icon} name="plus" />Criar pedido manual</button>`}</div>
      ${creating && html`<${CreateForm} onCreated=${(code: string) => {
        onChange();
        location.hash = `#/p/${code}`;
      }} />`}
    </div>
  </div>`;
}

function CreateForm({ onCreated }: { onCreated: (code: string) => void }) {
  const [f, setF] = useState({ process_code: "", description: "", supplier: "" });
  const submit = async (e: Event) => {
    e.preventDefault();
    const code = f.process_code.trim().toUpperCase();
    if (!/^(GOC|BBI)\d{5}$/.test(code)) {
      toast("Use o formato GOC12345 ou BBI12345", true);
      return;
    }
    if (await attempt(() => api("POST", "/api/process", { ...f, process_code: code }), `${code} criado`)) onCreated(code);
  };
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return html`<form class="row" style=${{ marginTop: "10px" }} onSubmit=${submit}>
    <input placeholder="BBI25999" value=${f.process_code} onInput=${set("process_code")} style=${{ width: "130px" }} />
    <input placeholder="Descrição" value=${f.description} onInput=${set("description")} style=${{ flex: 1, minWidth: "200px" }} />
    <input placeholder="Fornecedor" value=${f.supplier} onInput=${set("supplier")} />
    <button class="primary" type="submit">Criar e seguir</button>
  </form>`;
}

// ---------- Notificações ----------

function Notifications({ onChange }: { onChange: () => void }) {
  const [rows, setRows] = useState<NotificationView[] | null>(null);
  const load = () => api("GET", "/api/notifications").then((d) => setRows(d.notifications)).catch((e) => toast(e.message, true));
  useEffect(() => {
    load();
  }, []);
  const read = async (ids?: number[]) => {
    await attempt(() => api("POST", "/api/notifications/read", { ids }));
    load();
    onChange();
  };
  if (!rows) return html`<div class="loading">Carregando…</div>`;
  return html`<div>
    <div class="row"><h1>Notificações</h1><span class="spacer"></span>
      ${rows.some((r) => !r.read_at) && html`<${IconBtn} icon="checkCheck" tip="Marcar todas como lidas" onClick=${() => read()} />`}</div>
    <div class="card section">
      ${rows.length === 0
        ? html`<div class="empty"><p>Nenhuma notificação ainda. Elas chegam para quem segue o pedido ou o desenvolvimento e para os times envolvidos em cada etapa.</p></div>`
        : rows.map(
            (n) => html`<div class=${"list-row notif" + (n.read_at ? "" : " unread")}>
              <div style=${{ flex: 1, minWidth: 0 }}>
                <a href=${n.process_code?.startsWith("dev:") ? `#/dev/${n.process_code.slice(4)}` : n.pi_number ? `#/p/${displayPi(n.pi_number)}` : n.process_code ? `#/p/${n.process_code}` : "#/"} onClick=${() => !n.read_at && read([n.id])}>${n.title}</a>
                ${n.body && html`<div class="small muted" style=${{ fontWeight: 400 }}>${linkify(n.body)}</div>`}
              </div>
              <span class="small faint" style=${{ fontWeight: 400 }}>${n.reason?.startsWith("time:") ? `Time ${n.reason.slice(5)} · ` : ""}${when(n.created_at)}</span>
            </div>`,
          )}
    </div>
  </div>`;
}

// ---------- Perguntar (IA) ----------

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  /** Consultas que a IA fez para responder (planilha, GDI, Monday…). */
  consultas?: string[];
}

const SOURCE_LABEL: Record<string, string> = {
  pedido: "pedido", buscar_pedidos: "busca de pedidos", fretes: "fretes", itapeva_ordens: "OPs de Itapeva",
  itapeva_estoque: "estoque de Itapeva", itapeva_romaneios: "romaneios de Itapeva", itapeva_pausas: "pausas de Itapeva", monday: "Monday", estoque_wms: "estoque do WMS",
};

const SUGGESTIONS = ["O que está atrasado nos meus pedidos?", "Quais fretes chegam em Santos nos próximos 15 dias?", "Quantas OPs estão em produção em Itapeva agora?"];

/** Uma linha da resposta: códigos de pedido viram link, **negrito** e links externos. */
function richLine(line: string) {
  return line.split(/(\*\*[^*]+\*\*|\b(?:GOC|BBI)\d{5}(?:\.\d+)?\b|https?:\/\/\S+)/g).map((p) => {
    if (/^\*\*.+\*\*$/.test(p)) return html`<b>${p.slice(2, -2)}</b>`;
    if (/^(GOC|BBI)\d{5}/.test(p)) return html`<a class="mono" href=${`#/p/${p}`}>${p}</a>`;
    if (/^https?:\/\//.test(p)) return html`<a href=${p} target="_blank" rel="noopener">${p}</a>`;
    return p;
  });
}

function Answer({ text }: { text: string }) {
  return html`<div class="answer">${text.split("\n").map((l) => {
    const bullet = l.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) return html`<div class="bullet">${richLine(bullet[1])}</div>`;
    if (/^#+\s/.test(l)) return html`<div><b>${richLine(l.replace(/^#+\s/, ""))}</b></div>`;
    return l.trim() ? html`<div>${richLine(l)}</div>` : html`<div class="gap"></div>`;
  })}</div>`;
}

function Chat({ me }: { me: Me }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem("freeway-chat") ?? "[]");
    } catch {
      return [];
    }
  });
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      sessionStorage.setItem("freeway-chat", JSON.stringify(msgs.slice(-30)));
    } catch {
      // Sem sessionStorage a conversa só não sobrevive ao recarregar.
    }
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs, busy]);
  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    const next: ChatMsg[] = [...msgs, { role: "user", content: question }];
    setMsgs(next);
    setQ("");
    setBusy(true);
    try {
      const r = await api<{ answer: string; consultas: string[] }>("POST", "/api/chat", { messages: next.map(({ role, content }) => ({ role, content })) });
      setMsgs([...next, { role: "assistant", content: r.answer || "Não consegui responder.", consultas: r.consultas }]);
    } catch (err) {
      toast((err as Error).message, true);
      setMsgs(msgs);
      setQ(question);
    }
    setBusy(false);
  };
  if (!me.integrations.ai) return html`<${Empty} title="IA não configurada"><p>Falta o token do AI Proxy em Configuração.</p></${Empty}>`;
  return html`<div class="chat">
    <div class="row"><h1>Perguntar</h1><span class="spacer"></span>
      ${msgs.length > 0 && html`<${IconBtn} icon="reopen" variant="ghost" tip="Nova conversa" onClick=${() => setMsgs([])} />`}</div>
    <p class="small muted">A IA consulta o que precisar para responder: a planilha de importação (pedidos e fretes), a planilha de produtos e estoque do WMS, o GDI de Itapeva (OPs, estoque, romaneios, pausas), os quadros do Monday e o que é marcado no Freeway.</p>
    <div class="card chat-log">
      ${msgs.length === 0 &&
      html`<div class="empty"><p>Pergunte sobre prazos, fretes, etapas ou pendências.</p>
        <div class="row" style=${{ justifyContent: "center" }}>${SUGGESTIONS.map((s) => html`<button class="small" onClick=${() => ask(s)}>${s}</button>`)}</div></div>`}
      ${msgs.map(
        (m) => html`<div class=${"msg " + m.role}>
          ${m.role === "user" ? m.content : html`<${Answer} text=${m.content} />`}
          ${m.consultas?.length ? html`<div class="small faint" style=${{ marginTop: "6px" }} data-tip=${m.consultas.join("\n")}>Consultou: ${[...new Set(m.consultas.map((c) => SOURCE_LABEL[c.split(" ")[0]] ?? c.split(" ")[0]))].join(", ")}</div>` : ""}
        </div>`,
      )}
      ${busy && html`<div class="msg assistant"><span class="faint">Pensando…</span></div>`}
      <div ref=${end}></div>
    </div>
    <form class="row chat-input" onSubmit=${(e: Event) => {
      e.preventDefault();
      ask(q);
    }}>
      <textarea rows="2" placeholder="Ex.: quando chega o BBI25205.2?" value=${q} disabled=${busy}
        onInput=${(e: any) => setQ(e.target.value)}
        onKeyDown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            ask(q);
          }
        }}></textarea>
      <${IconBtn} icon="send" variant="primary" type="submit" tip="Enviar" disabled=${busy || !q.trim()} />
    </form>
  </div>`;
}

// ---------- Configuração ----------

/** Escolha dos quadros do Monday que entram na sincronização. */
function MondayBoards() {
  const [data, setData] = useState<{ boards: any[]; listed_at: string | null; selected: { id: string; name: string }[] } | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const load = async (refresh = false) => {
    setLoading(true);
    try {
      setData(await api("GET", `/api/admin/monday/boards${refresh ? "?refresh=1" : ""}`));
    } catch (err) {
      toast((err as Error).message, true);
    }
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);
  const sel = new Set(data?.selected.map((s) => s.id) ?? []);
  const toggle = async (id: string) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      const r = await api("PUT", "/api/admin/monday/boards", { ids: [...next] });
      setData({ ...data!, selected: r.selected });
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  const words = q.trim().toLowerCase();
  // Os marcados ficam sempre no topo; o resto filtra pela busca.
  const rows = (data?.boards ?? [])
    .filter((b) => sel.has(b.id) || !words || `${b.name} ${b.workspace ?? ""}`.toLowerCase().includes(words))
    .sort((a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)));
  const shown = rows.slice(0, 80);
  return html`<div class="section card">
    <div class="row"><h2 style=${{ margin: 0 }}>Quadros do Monday</h2><span class="spacer"></span>
      <${IconBtn} icon="refresh" spin=${loading} disabled=${loading} tip="Ler a lista de quadros de novo" onClick=${() => load(true)} /></div>
    <p class="small muted">Marque os quadros que o Freeway deve ler. Só os marcados entram na sincronização a cada 30 minutos.${data?.listed_at ? ` Lista lida em ${when(data.listed_at)}.` : ""}</p>
    ${!data
      ? html`<div class="loading">${loading ? "Lendo os quadros do Monday…" : "Não foi possível ler os quadros."}</div>`
      : html`<input placeholder="Buscar quadro ou workspace" style=${{ width: "100%" }} value=${q} onInput=${(e: any) => setQ(e.target.value)} />
        <div class="small faint" style=${{ marginTop: "6px" }}>${data.boards.length} quadros · ${sel.size} marcado(s)</div>
        ${shown.map(
          (b) => html`<label class="list-row" style=${{ cursor: "pointer" }}>
            <input type="checkbox" checked=${sel.has(b.id)} onChange=${() => toggle(b.id)} />
            <div style=${{ flex: 1, minWidth: 0 }}>
              <div>${b.name}</div>
              <div class="small faint">${[b.workspace, b.items != null && `${b.items} itens`, b.updated_at && `atualizado em ${fmtDate(b.updated_at.slice(0, 10), true)}`].filter(Boolean).join(" · ")}</div>
            </div>
          </label>`,
        )}
        ${rows.length > shown.length && html`<div class="small faint" style=${{ marginTop: "6px" }}>Mais ${rows.length - shown.length} quadros. Use a busca.</div>`}`}
  </div>`;
}

interface SlackInfo {
  configured: boolean;
  on: boolean;
  sent_7d: number;
  failed_7d: number;
  last_error: string | null;
  app_error: string | null;
  /** Sem a permissão files:write, os avisos saem sem a foto do produto. */
  files_off?: string | null;
}

/** Avisos no Slack: cada pessoa liga ou desliga para si e pode mandar uma mensagem de teste. */
function SlackCard({ me }: { me: Me }) {
  const [info, setInfo] = useState<SlackInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api("GET", "/api/slack").then(setInfo).catch((e) => toast(e.message, true));
  useEffect(() => {
    load();
  }, []);
  const toggle = async (on: boolean) => {
    if (await attempt(() => api("POST", "/api/slack", { on }), on ? "Avisos no Slack ligados" : "Avisos no Slack desligados")) load();
  };
  const test = async () => {
    setBusy(true);
    await attempt(() => api("POST", "/api/slack/test"), "Mensagem enviada: veja o app Freeway no Slack");
    setBusy(false);
    load();
  };
  return html`<div class="section card">
    <h2>Slack</h2>
    ${!info
      ? html`<div class="loading">Carregando…</div>`
      : !info.configured
        ? html`<p class="small muted">O Freeway ainda não está ligado ao Slack: falta gravar o token do app (secret <span class="mono">SLACK_BOT_TOKEN</span>) no GoDeploy.</p>`
        : html`<p class="small muted">Os mesmos avisos do sino chegam por mensagem direta do app Freeway no Slack, como um cartão: foto do produto, nome do pedido ou desenvolvimento, situação e o botão Abrir no Freeway.</p>
            <div class="row" style=${{ marginTop: "8px" }}>
              <label class="row"><input type="checkbox" checked=${info.on} onChange=${(e: any) => toggle(e.target.checked)} /> Receber meus avisos no Slack</label>
              <span class="spacer"></span>
              <${IconBtn} icon="send" disabled=${busy} tip="Mandar uma mensagem de teste para mim no Slack" onClick=${test} />
            </div>
            ${info.app_error && html`<p class="small" style=${{ color: "var(--late)", marginTop: "8px" }}>Os envios pararam: ${info.app_error}.</p>`}
            ${info.files_off && html`<p class="small" style=${{ color: "var(--risk)", marginTop: "8px" }}>Os avisos saem como cartão, mas ${info.files_off}.</p>`}
            ${me.isAdmin &&
            html`<p class="small faint" style=${{ marginTop: "8px" }}>Últimos 7 dias: ${info.sent_7d} mensagem(ns) enviada(s)${info.failed_7d ? ` · ${info.failed_7d} sem envio (último: ${info.last_error})` : ""}.</p>`}`}
  </div>`;
}

function Config({ me }: { me: Me }) {
  const [teams, setTeams] = useState<{ key: string; name: string; members: string[] }[] | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [newMember, setNewMember] = useState<Record<string, string>>({});
  const [newAdmin, setNewAdmin] = useState("");
  const [fedex, setFedex] = useState<{ busy: boolean; ok?: boolean; message?: string }>({ busy: false });
  const testFedex = async () => {
    setFedex({ busy: true });
    try {
      const r = await api("POST", "/api/admin/fedex/test");
      setFedex({ busy: false, ok: r.ok, message: r.message });
      toast(r.ok ? "FedEx respondeu" : "A FedEx não aceitou", !r.ok);
    } catch (e) {
      setFedex({ busy: false, ok: false, message: (e as Error).message });
    }
  };
  const [fiscalBusy, setFiscalBusy] = useState(false);
  const checkFiscal = async () => {
    setFiscalBusy(true);
    try {
      const r = await api("POST", "/api/admin/fiscal/check");
      setStatus((s: any) => ({ ...s, fiscal: r }));
      toast(r.ok ? "Planilha do fiscal: acesso ok" : "Ainda sem acesso à planilha do fiscal", !r.ok);
    } catch (e) {
      toast((e as Error).message, true);
    }
    setFiscalBusy(false);
  };
  const loadTeams = () => api("GET", "/api/teams").then((d) => setTeams(d.teams));
  const loadStatus = () => (me.isAdmin ? api("GET", "/api/admin/status").then(setStatus) : Promise.resolve());
  useEffect(() => {
    loadTeams().catch((e) => toast(e.message, true));
    loadStatus().catch((e) => toast(e.message, true));
  }, []);
  const member = async (team: string, email: string, add: boolean) => {
    if (await attempt(() => api(add ? "POST" : "DELETE", `/api/teams/${team}/members`, { email }), add ? "Adicionado" : "Removido")) {
      setNewMember({ ...newMember, [team]: "" });
      loadTeams();
    }
  };
  const importFile = async (e: any) => {
    const file: File | undefined = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    setResult(null);
    try {
      const r = await api("POST", "/api/admin/import-xlsx", undefined, await file.arrayBuffer());
      setResult(r);
      toast(r.skipped ? "Nada mudou desde a última leitura" : "Planilha importada");
      loadStatus();
    } catch (err) {
      toast((err as Error).message, true);
    }
    setImporting(false);
  };
  const syncNow = async () => {
    setImporting(true);
    try {
      setResult(await api("POST", "/api/admin/sync-now"));
      loadStatus();
    } catch (err) {
      toast((err as Error).message, true);
    }
    setImporting(false);
  };
  const admin = async (email: string, add: boolean) => {
    if (await attempt(() => api(add ? "POST" : "DELETE", "/api/admin/admins", { email }), add ? "Admin adicionado" : "Admin removido")) {
      setNewAdmin("");
      loadStatus();
    }
  };
  return html`<div>
    <h1>Configuração</h1>
    <div class="section card">
      <h2>Times</h2>
      <p class="small muted">Os membros recebem as notificações do time (ex.: desembaraço concluído → Itapeva) e veem as pendências do time na tela inicial.${me.isAdmin ? "" : " Só administradores podem alterar."}</p>
      ${!teams
        ? html`<div class="loading">Carregando…</div>`
        : html`<div class="grid2">${teams.map(
            (t) => html`<div class="step-card">
              <h3>${t.name}</h3>
              <div class="members" style=${{ marginTop: "8px" }}>
                ${t.members.length === 0 && html`<span class="small faint">Ninguém ainda</span>`}
                ${t.members.map((m) => html`<span class="chip">${m}${me.isAdmin && html` <a href="javascript:void 0" aria-label=${`Remover ${m} do time`} data-tip="Remover do time" onClick=${() => member(t.key, m, false)}>×</a>`}</span>`)}
              </div>
              ${me.isAdmin &&
              html`<form class="row" style=${{ marginTop: "8px" }} onSubmit=${(e: Event) => {
                e.preventDefault();
                if (newMember[t.key]) member(t.key, newMember[t.key], true);
              }}>
                <input type="email" placeholder="nome@gocase.com" style=${{ flex: 1 }} value=${newMember[t.key] ?? ""} onInput=${(e: any) => setNewMember({ ...newMember, [t.key]: e.target.value })} />
                <${IconBtn} icon="plus" type="submit" tip=${`Adicionar ao time ${t.name}`} />
              </form>`}
            </div>`,
          )}</div>`}
    </div>

    <${SlackCard} me=${me} />

    ${me.isAdmin &&
    html`<div class="section card">
      <h2>Planilha de importação</h2>
      <p class="small muted">Leitura automática: <b>${autoSyncText(me).text}</b>.</p>
      <div class="row">
        ${me.integrations.sheets && html`<${IconBtn} icon="refresh" spin=${importing} disabled=${importing} tip="Ler a planilha agora" onClick=${syncNow} />`}
        <span style=${{ display: "inline-flex" }}><${IconBtn} icon="upload" disabled=${importing} tip="Enviar uma planilha .xlsx à mão" onClick=${(e: any) => e.currentTarget.nextElementSibling.click()} />
          <input type="file" accept=".xlsx" style=${{ display: "none" }} onChange=${importFile} /></span>
      </div>
      ${result &&
      html`<div class="small" style=${{ marginTop: "10px" }}>
        ${result.skipped
          ? "Nenhuma mudança desde a última leitura."
          : html`<div>${result.baseline ? "Primeira carga (linha de base, sem notificações). " : ""}Lidos: ${Object.entries(result.counts).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ")}.</div>
              <div>Alterados: ${Object.entries(result.changed).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ")}. Eventos: ${result.events}. Notificações: ${result.notifications}.</div>`}
        ${result.issuesTotal > 0 && html`<div class="faint">${result.issuesTotal} linha(s) ignorada(s) ou com problema. Veja abaixo.</div>`}
      </div>`}
      ${status &&
      html`<div style=${{ marginTop: "14px" }}>
        <div class="small muted">No Freeway: ${status.counts.processos} pedidos (${status.counts.abertos} com importação em andamento), ${status.counts.embarques} embarques, ${status.counts.ativos} pedidos seguidos.</div>
        <table class="items">
          <thead><tr><th>Quando</th><th>Origem</th><th>Resultado</th></tr></thead>
          <tbody>${status.syncs.map(
            (s: any) => html`<tr><td class="small">${when(s.ran_at)}</td><td class="small">${s.source}</td>
              <td class="small">${!s.ok ? "Falhou" : s.summary.skipped ? "Sem mudanças" : `${s.summary.changed?.processos ?? 0} pedidos e ${s.summary.changed?.embarques ?? 0} embarques alterados · ${s.summary.events ?? 0} eventos`}</td></tr>`,
          )}</tbody>
        </table>
        ${status.issues.length > 0 &&
        html`<details style=${{ marginTop: "10px" }}><summary class="small">Linhas ignoradas na última leitura (${status.issues.length})</summary>
          <ul class="small muted">${status.issues.map((i: any) => html`<li>${i.tab}, linha ${i.row}: ${i.message}</li>`)}</ul></details>`}
      </div>`}
    </div>

    <div class="section card">
      <h2>Integrações</h2>
      <div class="list-row"><span class="dot" style=${{ background: autoSyncText(me).on ? "var(--done)" : "var(--border-strong)" }}></span><div style=${{ flex: 1 }}>Leitura automática da planilha</div><span class="small muted">${autoSyncText(me).text}</span></div>
      <div class="list-row"><span class="dot" style=${{ background: me.integrations.fedex ? "var(--done)" : "var(--border-strong)" }}></span><div style=${{ flex: 1 }}>Rastreio FedEx automático${fedex.message && html`<div class="small" style=${{ color: fedex.ok ? "var(--done)" : "var(--late)" }}>${fedex.message}</div>`}</div><span class="small muted">${me.integrations.fedex ? "Ligado · consulta a cada 2 h" : "Faltam as credenciais da FedEx"}</span>
        ${me.isAdmin && me.integrations.fedex && html`<${IconBtn} icon=${fedex.busy ? "refresh" : "play"} spin=${fedex.busy} disabled=${fedex.busy} tip="Testar as chaves da FedEx agora" onClick=${testFedex} />`}</div>
      <div class="list-row"><span class="dot" style=${{ background: me.integrations.ai ? (status?.ai?.errors ? "var(--risk)" : "var(--done)") : "var(--border-strong)" }}></span><div style=${{ flex: 1 }}>Leitura da IA dos pedidos seguidos (AI Proxy)</div>
        <span class="small muted">${!me.integrations.ai ? "Falta o token" : status?.ai?.last_at ? `Ligada · ${status.ai.ok} pedido(s) lidos${status.ai.errors ? ` · ${status.ai.errors} com erro: ${status.ai.last_error}` : ""}` : "Ligada · lê os pedidos seguidos a cada 30 min"}</span></div>
      <div class="list-row"><span class="dot" style=${{ background: me.integrations.monday ? "var(--done)" : "var(--border-strong)" }}></span><div style=${{ flex: 1 }}>Monday</div><span class="small muted">${me.integrations.monday ? "Token configurado · escolha os quadros abaixo" : "Falta o token"}</span></div>
      <div class="list-row"><span class="dot" style=${{ background: me.integrations.itapeva ? "var(--done)" : "var(--border-strong)" }}></span><div style=${{ flex: 1 }}>Industrialização de Itapeva (GDI)</div><span class="small muted">${me.integrations.itapeva ? "Ligada · lê as ordens de produção do GDI a cada hora" : "Falta a chave do GDI · marcação manual por embarque"}</span></div>
      ${status &&
      html`<div class="list-row"><span class="dot" style=${{ background: status.fiscal?.ok ? "var(--done)" : status.fiscal ? "var(--late)" : "var(--border-strong)" }}></span>
        <div style=${{ flex: 1 }}>Planilha do fiscal (Notas de Importação)${status.fiscal?.error && html`<div class="small" style=${{ color: "var(--late)" }}>${status.fiscal.error}</div>`}</div>
        <span class="small muted">${!status.fiscal ? "Ainda não conferida" : status.fiscal.ok ? `Acesso ok · ${status.fiscal.rows} processos${status.fiscal.linked != null ? ` · ${status.fiscal.linked} ligados a embarques` : ""} · ${when(status.fiscal.checked_at)}` : `Sem acesso · ${when(status.fiscal.checked_at)}`}</span>
        <${IconBtn} icon=${fiscalBusy ? "refresh" : "play"} spin=${fiscalBusy} disabled=${fiscalBusy} tip="Conferir agora o acesso à planilha do fiscal" onClick=${checkFiscal} /></div>`}
      <div class="list-row"><span class="dot" style=${{ background: me.integrations.slack ? "var(--done)" : "var(--border-strong)" }}></span><div style=${{ flex: 1 }}>Avisos no Slack</div><span class="small muted">${me.integrations.slack ? "Ligado · mensagem direta do app Freeway" : "Falta o token do app do Slack"}</span></div>
    </div>

    ${me.integrations.monday && html`<${MondayBoards} />`}

    ${status &&
    html`<div class="section card">
      <h2>Administradores</h2>
      <div class="members">${status.admins.map((a: string) => html`<span class="chip">${a}${a !== me.email && html` <a href="javascript:void 0" aria-label=${`Remover ${a}`} data-tip="Remover administrador" onClick=${() => admin(a, false)}>×</a>`}</span>`)}</div>
      <form class="row" style=${{ marginTop: "8px" }} onSubmit=${(e: Event) => {
        e.preventDefault();
        if (newAdmin) admin(newAdmin, true);
      }}>
        <input type="email" placeholder="nome@gocase.com" value=${newAdmin} onInput=${(e: any) => setNewAdmin(e.target.value)} />
        <${IconBtn} icon="plus" type="submit" tip="Adicionar administrador" />
      </form>
    </div>`}`}
  </div>`;
}

// ---------- App ----------

function App() {
  const hash = useHash();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loadMe = () =>
    api<Me>("GET", "/api/me")
      .then((m) => {
        setMe(m);
        setErr(null);
        // Leitura da base da fábrica em segundo plano (o servidor só lê de fato a cada 30 min).
        api("POST", "/api/factory/refresh").catch(() => {});
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    loadMe();
  }, [hash]);

  let page: ComponentChildren;
  const m = hash.match(/^#\/p\/((?:GOC|BBI)\d{5}(?:\.\d+)?)/);
  const dm = hash.match(/^#\/dev\/(\d+)/);
  if (err && !me) page = html`<${Empty} title="Não foi possível carregar"><p>${err}</p><${IconBtn} icon="refresh" tip="Tentar de novo" onClick=${loadMe} /></${Empty}>`;
  else if (!me) page = html`<div class="loading">Carregando…</div>`;
  else if (m) page = html`<${ProcessRoute} id=${m[1]} me=${me} onChange=${loadMe} />`;
  else if (dm) page = html`<${DevRoute} id=${dm[1]} />`;
  else if (hash.startsWith("#/dev")) page = html`<${DevList} me=${me} />`;
  else if (hash.startsWith("#/agenda")) page = html`<${AgendaPage} />`;
  else if (hash.startsWith("#/galeria") || hash.startsWith("#/calendario")) page = html`<${LaunchGallery} />`;
  else if (hash.startsWith("#/buscar")) page = html`<${Search} onChange=${loadMe} />`;
  else if (hash.startsWith("#/notificacoes")) page = html`<${Notifications} onChange=${loadMe} />`;
  else if (hash.startsWith("#/config")) page = html`<${Config} me=${me} />`;
  else if (hash.startsWith("#/perguntar")) page = html`<${Chat} me=${me} />`;
  else page = html`<${Home} me=${me} onChange=${loadMe} />`;

  return html`<${Header} me=${me} hash=${hash} /><main>${page}</main><${Toast} />`;
}

render(html`<${App} />`, document.getElementById("app")!);
