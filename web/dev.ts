import { type ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ColorSwatch, DevInfoView, DevLink, DevProjectView, DevSheet, DevTask, GaleriaInfo, SkuListView, StepView } from "../src/shared/types";
import { launchMonth } from "../src/shared/months";
import { fmtDate, fmtQty } from "../src/shared/labels";
import { api, attempt, Empty, fillWidth, HealthChip, html, Legend, type Me, pct, StatusChip, Swatch, toast, todayIso, Tracks } from "./core";
import { Icon, IconBtn } from "./icons";

// Trilha de desenvolvimento: lançamentos dos quadros Launches (Monday), tarefas, Waitlist/CTR e lista de SKUs.

const TASK_ICON: Record<DevTask["state"], [string, string]> = {
  done: ["checkCircle", "done"],
  doing: ["clock", "doing"],
  late: ["clock", "late"],
  blocked: ["ban", "late"],
  todo: ["circle", "todo"],
  na: ["ban", "todo"],
};

/** Tarefas do Monday de uma etapa (subelementos do lançamento). */
export function TaskList({ tasks, title }: { tasks?: DevTask[]; title?: string }) {
  if (!tasks?.length) return null;
  return html`<div class="dev-tasks">
    ${title && html`<div class="small faint" style=${{ marginBottom: "4px" }}>${title}</div>`}
    ${tasks.map((t) => {
      const [icon, cls] = TASK_ICON[t.state];
      const when = t.state === "done" ? (t.done_at ? `pronto em ${fmtDate(t.done_at, true)}` : "") : t.due ? `prazo ${fmtDate(t.due, true)}` : "";
      return html`<div class="dev-task">
        <span class=${`cell-ico ${cls}`}><${Icon} name=${icon} /></span>
        <span class="small" style=${{ flex: 1, minWidth: 0 }}>${t.name}<span class="faint">${[t.status, t.owner, when].filter(Boolean).map((x) => ` · ${x}`).join("")}</span></span>
      </div>`;
    })}
  </div>`;
}

const EDITABLE = new Set(["ctr", "waitlist", "cores", "amostra_fab"]);
const RERUN_LABEL: Record<string, string> = { ctr: "Rodar o CTR de novo", waitlist: "Rodar a waitlist de novo", amostra_fab: "Fazer uma nova amostra" };
const pctBr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1).replace(".", ",")}%`);
const brl = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** Links da etapa: os da planilha de acompanhamento e o informado no app. */
function StepLinks({ d }: { d: Record<string, any> }) {
  const links: DevLink[] = [...(d.links ?? [])];
  if (d.link) links.push({ label: "Link (app)", url: d.link });
  if (!links.length) return null;
  return html`<div class="dev-links small">${links.map((l) => html`<a href=${l.url} target="_blank" rel="noopener">${l.label} ↗</a>`)}</div>`;
}

/** Resultado da waitlist (aba BD) e os votos por cor. */
function WaitlistResult({ d }: { d: Record<string, any> }) {
  const r = d.result as DevSheet["result"];
  const v = d.votes as DevSheet["votes"];
  if (!r && !v && !d.situation) return null;
  return html`<div class="dev-result small">
    ${d.situation && html`<div><span class="chip">${d.situation}</span></div>`}
    ${r && html`<div class="kv-mini">
      <span><b>${r.dias}</b> dias</span><span><b>${fmtQty(r.leads)}</b> leads</span><span><b>${brl(r.investimento)}</b> investidos</span>
      <span>custo/lead <b>${brl(r.custo_lead)}</b></span><span>CTR <b>${pctBr(r.ctr)}</b></span><span>lead/clique <b>${pctBr(r.lead_click)}</b></span>
      ${r.preco && html`<span>preço <b>${brl(r.preco)}</b></span>`}
      ${r.ultimo_dia && html`<span class="faint">até ${fmtDate(r.ultimo_dia, true)}</span>`}
    </div>`}
    ${v && v.cores.length > 0 && html`<div class="faint" style=${{ marginTop: "4px" }}>Votos por cor (${fmtQty(v.total)}): ${v.cores.slice(0, 6).map((c) => `${c.cor} ${String(c.pct).replace(".", ",")}%`).join(" · ")}</div>`}
  </div>`;
}

/** Testes de CTR (anúncios) com o nome do produto. */
function CtrTests({ tests }: { tests: DevSheet["tests"] }) {
  if (!tests?.length) return null;
  return html`<div class="dev-result small">
    ${tests.slice(0, 5).map(
      (t) => html`<div class="dev-test"><span class="dev-test-name">${t.teste}</span>
        <span class="faint">CTR <b>${pctBr(t.ctr)}</b> · CPC ${brl(t.cpc)} · ${t.cliques ?? "—"} cliques · ${brl(t.investimento)}${t.status ? ` · ${t.status.toLowerCase()}` : ""}${t.data ? ` · ${fmtDate(t.data, true)}` : ""}</span></div>`,
    )}
  </div>`;
}

/** Cores definidas (do app, do GoProduct ou da PO) e as mais votadas na waitlist. */
function Colors({ d }: { d: Record<string, any> }) {
  const colors: ({ name: string; source: string } & ColorSwatch)[] = d.color_list ?? [];
  const votes: { cor: string; pct: number }[] = d.votes ?? [];
  if (!colors.length && !votes.length) return null;
  return html`<div class="dev-result small">
    ${colors.length > 0 && html`<div class="color-chips">${colors.map((c) => html`<span class="color-chip"><${Swatch} c=${c} />${c.name}</span>`)}<span class="faint">${colors[0].source}</span></div>`}
    ${votes.length > 0 && html`<div class="faint" style=${{ marginTop: "4px" }}>Mais votadas na waitlist: ${votes.slice(0, 5).map((c) => `${c.cor} ${String(c.pct).replace(".", ",")}%`).join(" · ")}</div>`}
  </div>`;
}

/**
 * Cartão de uma etapa da trilha, com as tarefas do Monday. CTR, Waitlist, Cores e Fabricação aceitam
 * marcação no app (concluir, rodar de novo, não se aplica, prazo, link, observação e as cores).
 */
export function DevStepCard({ s, tasks, wide = false, scope, reload, children }: { s: StepView; tasks?: DevTask[]; wide?: boolean; scope?: string; reload?: () => void; children?: ComponentChildren }) {
  const d = s.data ?? {};
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const can = !!scope && !!reload && EDITABLE.has(s.key);
  const patch = async (p: Record<string, unknown>, ok: string) => {
    if (await attempt(() => api("PATCH", `/api/dev-step/${scope}/${s.key}`, p), ok)) {
      setEditing(false);
      reload!();
    }
  };
  const fields: [string, string, string][] = [
    ...(s.key === "cores" ? [["colors", "Cores (separadas por vírgula)", "text"] as [string, string, string]] : []),
    ["due", "Prazo", "date"],
    ["link", "Link", "url"],
    ["note", "Observação", "text"],
  ];
  const open = () => {
    setForm(Object.fromEntries(fields.map(([k]) => [k, k === "colors" ? (typeof d.colors === "string" ? d.colors : "") : d[k] ?? ""])));
    setEditing(true);
  };
  const save = (e: Event) => {
    e.preventDefault();
    patch(form, "Salvo");
  };
  const rerunning = d.rerun_at && (!d.done_at || d.done_at < d.rerun_at);
  return html`<div id=${`step-${s.key}`} class=${`step-card st-border-${s.status}${wide ? " wide" : ""}`}>
    <div class="head"><h3>${s.label}</h3><span class="spacer"></span><${StatusChip} status=${s.status} /></div>
    <div class="detail">${s.detail}${s.source === "monday" ? html` <span class="faint">· Monday</span>` : s.source === "planilha" ? html` <span class="faint">· planilha</span>` : ""}</div>
    ${s.status !== "na" && html`<div class="mini"><div class=${"fill st-" + s.status} style=${{ width: fillWidth(s), height: "100%" }}></div></div>`}
    ${s.key === "waitlist" && html`<${WaitlistResult} d=${d} />`}
    ${s.key === "ctr" && html`<${CtrTests} tests=${d.tests ?? []} />`}
    ${s.key === "cores" && html`<${Colors} d=${d} />`}
    <${StepLinks} d=${d} />
    <${TaskList} tasks=${tasks} />
    ${children}
    ${can &&
    (editing
      ? html`<form onSubmit=${save}>
          ${fields.map(([k, label, type]) => html`<label>${label}<input type=${type} value=${form[k] ?? ""} onInput=${(e: any) => setForm({ ...form, [k]: e.target.value })} /></label>`)}
          <div class="row"><${IconBtn} icon="check" variant="primary" type="submit" tip="Salvar" /><${IconBtn} icon="x" variant="ghost" tip="Cancelar" onClick=${() => setEditing(false)} /></div>
        </form>`
      : html`<div class="actions">
          ${s.status !== "na" && html`<${IconBtn} icon="pencil" tip=${`Editar ${s.label.toLowerCase()} (prazo, link, observação${s.key === "cores" ? ", cores" : ""})`} onClick=${open} />`}
          ${s.status !== "done" && s.status !== "na" && html`<${IconBtn} icon="checkCircle" tip="Concluir hoje" onClick=${() => patch({ done_at: todayIso() }, "Concluído")} />`}
          ${RERUN_LABEL[s.key] && s.status === "done" && html`<button class="small with-icon" onClick=${() => patch({ rerun_at: todayIso() }, "Rodando de novo")}><${Icon} name="refresh" />${RERUN_LABEL[s.key]}</button>`}
          ${(d.done_at || rerunning) && html`<${IconBtn} icon="reopen" variant="ghost" tip=${rerunning ? "Cancelar a nova rodada" : "Desfazer a conclusão no app"} onClick=${() => patch(rerunning ? { rerun_at: null } : { done_at: null }, "Desfeito")} />`}
          <${IconBtn} icon="ban" variant=${d.na ? "on" : "ghost"} tip=${d.na ? "Não se aplica. Clique para voltar a valer" : "Marcar como não se aplica"} onClick=${() => patch({ na: !d.na }, d.na ? "Etapa reativada" : "Marcada como não se aplica")} />
        </div>`)}
  </div>`;
}

const fileB64 = (file: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });

/**
 * Lista de SKUs: a PO do FileMaker vale primeiro, depois a planilha de importação. Antes delas, a lista
 * é temporária: dá para incluir à mão ou enviar a lista que o time monta por fora (a IA lê).
 */
export function SkuCard({ skus, reload }: { skus: SkuListView; reload: () => void }) {
  const [add, setAdd] = useState({ code: "", name: "", qty: "" });
  const [paste, setPaste] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const missing = skus.rows.filter((r) => r.code && !r.goproduct).length;
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const ok = await attempt(async () => {
      const r = await api<{ rows: number; via: string }>("POST", "/api/skus/import", { scope: skus.scope, ...body });
      toast(`${r.rows} SKU${r.rows === 1 ? "" : "s"} na lista${r.via === "ia" ? " (lida pela IA)" : ""}`);
    });
    setBusy(false);
    if (ok) {
      setPaste(null);
      reload();
    }
  };
  const upload = async (e: any) => {
    const file: File | undefined = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 3_000_000) return toast("O arquivo precisa ter até 3 MB", true);
    send({ file_b64: await fileB64(file), filename: file.name, mime: file.type });
  };
  const addRow = async (e: Event) => {
    e.preventDefault();
    if (await attempt(() => api("POST", "/api/skus", { scope: skus.scope, ...add }), "SKU incluído")) {
      setAdd({ code: "", name: "", qty: "" });
      reload();
    }
  };
  const remove = async (id: number) => {
    if (await attempt(() => api("DELETE", `/api/skus/${id}`), "SKU retirado")) reload();
  };
  return html`<div class="sku-card">
    <div class="row" style=${{ gap: "6px" }}>
      <b class="small">Lista de SKUs</b>
      <span class=${"chip" + (skus.source === "po" || skus.source === "planilha" ? " ok" : "")}>${skus.source_label}</span>
      ${missing > 0 && html`<span class="chip risk">${missing} fora do GoProduct</span>`}
    </div>
    ${skus.rows.length
      ? html`<table class="sku-table small">
          <tbody>
            ${skus.rows.map(
              (r) => html`<tr>
                <td class="mono">${r.code ?? "—"}</td>
                <td>${r.name ?? ""}</td>
                <td class="num">${r.qty != null ? fmtQty(r.qty) : ""}</td>
                <td>${r.code
                  ? r.goproduct
                    ? html`<a class="ok-text" href=${`https://goproduct.gogroupbr.com/web/part/${r.goproduct_pk}/details`} target="_blank" rel="noopener" data-tip="Cadastrado no GoProduct · abrir">✓ GoProduct</a>`
                    : html`<span class="risk-text" data-tip="Ainda não está no GoProduct (catálogo lido 1×/dia)">falta</span>`
                  : ""}</td>
                <td>${skus.editable && r.id != null && html`<${IconBtn} icon="x" variant="ghost" tip="Tirar da lista" onClick=${() => remove(r.id!)} />`}</td>
              </tr>`,
            )}
          </tbody>
        </table>`
      : html`<p class="small faint">Sem lista ainda. Inclua os SKUs à mão ou envie a lista que vocês montam para o supply; quando a PO sair no FileMaker, ela passa a valer.</p>`}
    ${skus.editable
      ? html`<form class="row sku-add" onSubmit=${addRow}>
            <input placeholder="Código (ex.: TX221004)" value=${add.code} onInput=${(e: any) => setAdd({ ...add, code: e.target.value })} style=${{ width: "130px" }} />
            <input placeholder="Nome" value=${add.name} onInput=${(e: any) => setAdd({ ...add, name: e.target.value })} style=${{ flex: 1, minWidth: "120px" }} />
            <input placeholder="Qtd" inputMode="numeric" value=${add.qty} onInput=${(e: any) => setAdd({ ...add, qty: e.target.value })} style=${{ width: "70px" }} />
            <${IconBtn} type="submit" icon="plus" tip="Incluir o SKU" />
          </form>
          <div class="row" style=${{ gap: "6px", marginTop: "6px" }}>
            <button class="small with-icon" disabled=${busy} onClick=${() => setPaste(paste === null ? "" : null)}><${Icon} name="paperclip" /> Colar lista</button>
            <label class="button small with-icon" data-tip="Planilha (.xlsx ou .csv) ou foto da lista: a IA monta a lista quando não reconhece as colunas">
              <${Icon} name="upload" /> Enviar arquivo
              <input type="file" accept=".xlsx,.csv,.txt,image/*" style=${{ display: "none" }} onChange=${upload} />
            </label>
            ${busy && html`<span class="small faint">Lendo a lista…</span>`}
          </div>
          ${paste !== null &&
          html`<div style=${{ marginTop: "6px" }}>
            <textarea rows="5" placeholder="Cole aqui a lista (copie as colunas da planilha: código, nome, quantidade)" value=${paste} onInput=${(e: any) => setPaste(e.target.value)} style=${{ width: "100%" }}></textarea>
            <div class="row" style=${{ gap: "6px" }}><button class="small primary" disabled=${busy || !paste.trim()} onClick=${() => send({ text: paste })}>Ler a lista</button><span class="small faint">A lista lida substitui a anterior enviada desta forma.</span></div>
          </div>`}`
      : html`<p class="small faint" style=${{ marginTop: "6px" }}>${skus.source === "po" ? "Lida da PO na pasta do pedido no Drive (FileMaker)." : "Vem dos itens do pedido na planilha de importação."} A lista temporária deixou de valer.</p>`}
  </div>`;
}

function DevHeaderLine({ info }: { info: DevInfoView }) {
  return html`<div class="small muted" style=${{ marginTop: "2px" }}>
    ${[info.board, info.launch_group, info.tipo, info.people.length ? `com ${info.people.join(", ")}` : null].filter(Boolean).join(" · ")}
  </div>`;
}

const STAGE_SHORT = (s: string | null) => (s ? s.replace(/^Stage\s*/i, "").replace(/\s*-\s*/, " · ") : "");

/** Seção Desenvolvimento no topo do pedido: de onde vem (lançamento no Monday) e o que falta. */
export function DevBanner({ info, others }: { info: DevInfoView | null; others: { item_id: string; name: string; url: string | null }[] }) {
  if (!info) {
    return html`<p class="small faint" style=${{ margin: "0 0 8px" }}>Sem lançamento ligado no Monday: CTR, waitlist, cores e fabricação da amostra não se aplicam. O lançamento liga ao pedido pela coluna Process do Launches.</p>`;
  }
  return html`<div class="small" style=${{ margin: "0 0 8px" }}>
    Lançamento <a href=${`#/dev/${info.item_id}`}>${info.name}</a>
    ${info.url && html` · <a href=${info.url} target="_blank" rel="noopener">Monday ↗</a>`}
    <span class="faint"> · ${[info.launch_group, STAGE_SHORT(info.stage), info.launch_status, info.people.join(", ")].filter(Boolean).join(" · ")}</span>
    ${others.length > 0 && html`<span class="faint"> · também: ${others.map((o, i) => html`${i ? ", " : ""}<a href=${`#/dev/${o.item_id}`}>${o.name}</a>`)}</span>`}
  </div>`;
}

/** Seguir o lançamento: aparece em Seguindo e avisa quando uma etapa conclui, atrasa ou trava. */
function DevWatchButton({ p, reload }: { p: DevProjectView; reload: () => void }) {
  const watch = async () => {
    if (await attempt(() => api(p.watching ? "DELETE" : "POST", `/api/dev/${p.info.item_id}/watch`), p.watching ? "Você deixou de seguir" : "Seguindo")) reload();
  };
  const tip = p.watching ? "Clique para deixar de seguir" : "Passa a aparecer em Seguindo, com aviso quando uma etapa concluir, atrasar ou travar";
  return html`<button class=${"small with-icon" + (p.watching ? "" : " primary")} data-tip=${tip} onClick=${watch}><${Icon} name="pin" filled=${!!p.watching} />${p.watching ? "Seguindo" : "Seguir"}</button>`;
}

export function DevCard({ p }: { p: DevProjectView }) {
  const i = p.info;
  return html`<div class="card order">
    <div class="row">
      <a class="code" href=${`#/dev/${i.item_id}`}>${i.name}</a>
      ${p.watching && html`<span class="faint" data-tip="Você segue este desenvolvimento" style=${{ display: "inline-flex" }}><${Icon} name="pin" filled=${true} /></span>`}
      ${i.process_codes.map((c) => html`<a class="chip accent" href=${`#/p/${c}`}>${c}</a>`)}
      <span class="spacer"></span>
      ${i.launch_status && html`<span class="chip">${i.launch_status}</span>`}
      <${HealthChip} health=${p.health} />
      <span class="pct">${pct(p.total)}</span>
    </div>
    <${DevHeaderLine} info=${i} />
    <${Tracks} steps=${p.steps} compact=${true} />
    <div class="meta row small" style=${{ marginTop: "8px" }}>
      <span><span class="faint">Agora: </span>${p.current}</span>
      ${p.next_task && p.next_task.due && html`<span><span class="faint">Próxima tarefa: </span>${p.next_task.name} · ${fmtDate(p.next_task.due, true)}</span>`}
    </div>
  </div>`;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Lançamentos abertos nos quadros Launches: os que ainda não têm pedido e os que já têm. */
export function DevList({ me }: { me: Me }) {
  const [data, setData] = useState<{ projects: DevProjectView[]; boards: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  useEffect(() => {
    api<{ projects: DevProjectView[]; boards: string[] }>("GET", "/api/dev").then(setData).catch((e) => setErr(e.message));
  }, []);
  if (err) return html`<${Empty} title="Não foi possível carregar"><p>${err}</p></${Empty}>`;
  if (!data) return html`<div class="loading">Carregando…</div>`;
  if (!data.boards.length) return html`<${Empty} title="Nenhum quadro Launches"><p>Escolha os quadros Launches do Monday em Configuração para ver os lançamentos em desenvolvimento.</p></${Empty}>`;
  const words = fold(q).split(/\s+/).filter(Boolean);
  const email = me.email.toLowerCase();
  const list = data.projects.filter((p) => {
    if (mine && !p.info.emails.includes(email) && !p.watching) return false;
    const text = fold([p.info.name, p.info.launch_group, p.info.tipo, p.info.people.join(" "), p.info.process_codes.join(" "), p.info.stage].filter(Boolean).join(" "));
    return words.every((w) => text.includes(w));
  });
  const without = list.filter((p) => !p.info.process_codes.length);
  const withCode = list.filter((p) => p.info.process_codes.length);
  return html`<div>
    <div class="row" style=${{ marginBottom: "10px", gap: "10px" }}>
      <h1 style=${{ margin: 0 }}>Desenvolvimentos</h1>
      <span class="small faint">${data.boards.join(", ")}</span>
      <span class="spacer"></span>
      <div class="search-box"><${Icon} name="search" /><input placeholder="Buscar lançamento, pessoa, mês…" value=${q} onInput=${(e: any) => setQ(e.target.value)} /></div>
      <label class="row small" data-tip="Os que você segue ou em que está na coluna People"><input type="checkbox" checked=${mine} onChange=${(e: any) => setMine(e.target.checked)} /> Só os meus</label>
      <${Legend} />
    </div>
    <div class="section-title"><h2>Sem pedido ainda</h2><span class="small faint">${without.length}</span></div>
    ${without.length ? without.map((p) => html`<${DevCard} p=${p} />`) : html`<p class="small faint">Nenhum lançamento sem pedido${words.length || mine ? " com esse filtro" : ""}.</p>`}
    <div class="section-title" style=${{ marginTop: "18px" }}><h2>Já com pedido</h2><span class="small faint">${withCode.length}</span></div>
    ${withCode.length ? withCode.map((p) => html`<${DevCard} p=${p} />`) : html`<p class="small faint">Nenhum.</p>`}
  </div>`;
}

/** R$ 1,35 mi · R$ 635 mil · R$ 99,90 */
const brlShort = (n: number) => (Math.abs(n) >= 1e6 ? `R$ ${(n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} mi` : Math.abs(n) >= 1e4 ? `R$ ${Math.round(n / 1e3).toLocaleString("pt-BR")} mil` : brl(n));
const pctNum = (n: number) => `${n.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

/** Fotos e números do lançamento na Galeria de Lançamentos (só leitura). */
function GaleriaCard({ g, mondayGroup }: { g: GaleriaInfo; mondayGroup: string | null }) {
  const nums: [string, string | null][] = [
    ["Preço", g.preco != null ? brl(g.preco) : null],
    ["Custo", g.custo != null ? brl(g.custo) : null],
    ["FOB", g.fob != null ? `US$ ${g.fob.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null],
    ["Margem", g.margem != null ? pctNum(Math.abs(g.margem) <= 1 ? g.margem * 100 : g.margem) : null],
    ["CTR", g.ctr != null ? pctNum(g.ctr) : null],
    ["CPC", g.cpc != null ? brl(g.cpc) : null],
    ["Custo por lead", g.custo_lead != null ? brl(g.custo_lead) : null],
    ["Lead por clique", g.lead_click != null ? pctNum(g.lead_click) : null],
    ["Projeção 2026", g.proj2026 ? brlShort(g.proj2026) : null],
    ["Projeção 2027", g.proj2027 ? brlShort(g.proj2027) : null],
    ["Receita estimada", g.rec_estimada ? brlShort(g.rec_estimada) : null],
  ];
  const shown = nums.filter(([, v]) => v);
  const gm = launchMonth(g.mes);
  const mm = launchMonth(mondayGroup);
  const other = gm && mm && gm !== mm;
  return html`<div class="section card galeria-card">
    <div class="row">
      <h2 style=${{ margin: 0 }}>Galeria de Lançamentos</h2>
      ${g.status && html`<span class="chip">${g.status}</span>`}
      ${g.mes && html`<span class=${"chip" + (other ? " risk" : "")} data-tip=${other ? `No Monday o lançamento está em ${mondayGroup}` : "Mês de lançamento na Galeria"}>${g.mes}</span>`}
      <span class="spacer"></span>
      <a class="small" href="https://lancamentosgocase.devgogroup.com/" target="_blank" rel="noopener">Abrir a Galeria ↗</a>
    </div>
    ${other && html`<p class="small" style=${{ color: "var(--risk)", margin: "6px 0 0" }}>O mês na Galeria (${g.mes}) é diferente do grupo no Monday (${mondayGroup}).</p>`}
    <div class="small muted" style=${{ marginTop: "4px" }}>${[g.nome, g.tipo, g.categoria, g.subcategoria, g.teste && `teste: ${g.teste}${g.status_teste ? ` (${g.status_teste})` : ""}`, g.comentarios ? `${g.comentarios} comentário${g.comentarios === 1 ? "" : "s"}` : null, g.via === "nome" ? "ligado pelo nome" : null].filter(Boolean).join(" · ")}</div>
    ${g.fotos.length > 0 && html`<div class="galeria-fotos">${g.fotos.map((src) => html`<a href=${src} target="_blank" rel="noopener"><img src=${src} alt="" loading="lazy" /></a>`)}</div>`}
    ${shown.length > 0 && html`<div class="galeria-nums">${shown.map(([k, v]) => html`<div><span class="faint small">${k}</span><b>${v}</b></div>`)}</div>`}
    ${g.receita_mes.length > 0 && html`<div class="small" style=${{ marginTop: "8px" }}><span class="faint">Receita projetada por mês: </span>${g.receita_mes.map((r) => `${r.mes} ${brlShort(r.valor)}`).join(" · ")}</div>`}
  </div>`;
}

/** Página de um lançamento: a trilha com as tarefas do Monday e a lista de SKUs. */
export function DevRoute({ id }: { id: string }) {
  const [p, setP] = useState<DevProjectView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api<{ project: DevProjectView }>("GET", `/api/dev/${id}`).then((r) => setP(r.project)).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, [id]);
  if (err) return html`<${Empty} title="Lançamento não encontrado"><p>${err}</p><a href="#/dev">Voltar aos lançamentos</a></${Empty}>`;
  if (!p) return html`<div class="loading">Carregando…</div>`;
  const i = p.info;
  const by = Object.fromEntries(p.steps.map((s) => [s.key, s]));
  return html`<div>
    <div class="card">
      <div class="row">
        <h1>${i.name}</h1>
        ${i.stage && html`<span class="chip">${STAGE_SHORT(i.stage)}</span>`}
        ${i.launch_status && html`<span class="chip">${i.launch_status}</span>`}
        <span class="spacer"></span>
        <${DevWatchButton} p=${p} reload=${load} />
        <${HealthChip} health=${p.health} />
        <span class="pct">${pct(p.total)}</span>
      </div>
      <${DevHeaderLine} info=${i} />
      <${Tracks} steps=${p.steps} />
      <div class="meta row small" style=${{ marginTop: "12px" }}>
        <span><span class="faint">Agora: </span>${p.current}</span>
        <span class="spacer"></span>
        ${i.process_codes.map((c) => html`<a href=${`#/p/${c}`}>Pedido ${c} →</a>`)}
        ${i.url && html`<a href=${i.url} target="_blank" rel="noopener">Abrir no Monday ↗</a>`}
      </div>
      ${!i.process_codes.length && html`<div class="small faint" style=${{ marginTop: "6px" }}>Quando o PO sair e alguém preencher a coluna Process no Monday, este lançamento passa a fazer parte do pedido no Freeway.</div>`}
    </div>
    ${p.galeria && html`<${GaleriaCard} g=${p.galeria} mondayGroup=${i.launch_group} />`}
    <div class="section">
      <div class="section-title"><h2>Desenvolvimento</h2><span class="spacer"></span><${Legend} /></div>
      <div class="steps-grid">
        ${p.steps.map((s) =>
          s.key === "goproduct"
            ? html`<${DevStepCard} s=${by.goproduct} tasks=${i.tasks.goproduct} wide=${true}><${SkuCard} skus=${p.skus} reload=${load} /></${DevStepCard}>`
            : html`<${DevStepCard} s=${s} tasks=${i.tasks[s.key]} scope=${`dev:${i.item_id}`} reload=${load} />`,
        )}
      </div>
    </div>
    ${i.other_tasks.length > 0 &&
    html`<div class="section card"><${TaskList} tasks=${i.other_tasks} title="Outras tarefas do lançamento no Monday (fora das etapas)" /></div>`}
  </div>`;
}
