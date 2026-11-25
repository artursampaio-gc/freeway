// Cadastro único das etapas. Para incluir uma etapa nova simples (marcar
// concluída, prazo, link, observação), basta acrescentar uma entrada com
// kind "manual"; ela já aparece na barra, no detalhe e nos próximos passos.
//
// Escopo:
// - "order": acontece antes da divisão em fretes (amostra, produção, alinhamento).
//   É um fato do pedido original: todos os fretes mostram o mesmo estado.
// - "unit": quando o pedido é dividido em mais de um frete, cada frete é um
//   pedido distinto. Antes da divisão vale o do pedido; depois, o frete herda
//   o que foi marcado antes até ter um valor próprio.

export type Scope = "order" | "unit";
export type Track = "desenvolvimento" | "operacao" | "site" | "marketing";

export interface StepDef {
  key: string;
  label: string;
  short: string;
  scope: Scope;
  track: Track;
  weight: number;
  /** "manual" usa o cálculo genérico; os demais têm regra própria em view.ts. */
  kind: "manual" | "custom";
  /** Time responsável pelos próximos passos dessa etapa. */
  team?: string;
  /** Etapa que precisa estar concluída para esta começar (só para kind "manual"). */
  after?: string;
  /** Texto do próximo passo quando a etapa manual está liberada. */
  nextLabel?: string;
  onlyBBI?: boolean;
}

export const STEPS: StepDef[] = [
  // Desenvolvimento do produto (quadros Launches do Monday), até a documentação que libera a produção.
  { key: "ctr", label: "CTR", short: "CTR", scope: "order", track: "desenvolvimento", weight: 2, kind: "custom" },
  { key: "waitlist", label: "Waitlist", short: "Waitlist", scope: "order", track: "desenvolvimento", weight: 2, kind: "custom" },
  { key: "cores", label: "Definição de cores", short: "Cores", scope: "order", track: "desenvolvimento", weight: 2, kind: "custom" },
  { key: "amostra_fab", label: "Fabricação de amostra", short: "Fabricação", scope: "order", track: "desenvolvimento", weight: 3, kind: "custom" },
  // A chave continua "amostra" para manter o que já foi marcado (rastreio, entrega e aprovação ficam no mesmo registro).
  { key: "amostra", label: "Envio de amostra", short: "Envio", scope: "order", track: "desenvolvimento", weight: 3, kind: "custom" },
  { key: "amostra_validacao", label: "Validação da amostra", short: "Validação", scope: "order", track: "desenvolvimento", weight: 3, kind: "custom" },
  { key: "goproduct", label: "Cadastro no GoProduct", short: "GoProduct", scope: "order", track: "desenvolvimento", weight: 2, kind: "custom" },
  // Registro em "producao" (docs_done_at), como antes, quando era um ponto da Produção.
  { key: "documentacao", label: "Envio de documentação", short: "Documentação", scope: "order", track: "desenvolvimento", weight: 3, kind: "custom" },
  { key: "producao", label: "Produção", short: "Produção", scope: "order", track: "operacao", weight: 15, kind: "custom" },
  { key: "alinhamento", label: "Alinhamento de matriz", short: "Alinham.", scope: "order", track: "operacao", weight: 4, kind: "custom" },
  { key: "importacao", label: "Importação", short: "Importação", scope: "unit", track: "operacao", weight: 12, kind: "custom" },
  // A chave continua "sefaz" para manter o que já foi marcado: o desembaraço termina na liberação da SEFAZ.
  { key: "sefaz", label: "Desembaraço", short: "Desembaraço", scope: "unit", track: "operacao", weight: 8, kind: "custom" },
  { key: "chegada", label: "Chegada", short: "Chegada", scope: "unit", track: "operacao", weight: 5, kind: "custom" },
  { key: "fci", label: "FCI", short: "FCI", scope: "unit", track: "operacao", weight: 4, kind: "custom" },
  { key: "industrializacao", label: "Industrialização", short: "Industr.", scope: "unit", track: "operacao", weight: 8, kind: "custom", team: "itapeva", onlyBBI: true },
  { key: "mockups", label: "Mockups", short: "Mockups", scope: "unit", track: "site", weight: 6, kind: "manual", nextLabel: "Concluir os mockups" },
  { key: "cadastro_site", label: "Cadastro no site", short: "Site", scope: "unit", track: "site", weight: 6, kind: "manual", team: "ecommerce", after: "mockups", nextLabel: "Cadastrar o produto no site" },
  { key: "cadastro_wms", label: "Cadastro no WMS", short: "WMS", scope: "unit", track: "site", weight: 6, kind: "manual", team: "ecommerce", after: "mockups", nextLabel: "Cadastrar o produto no WMS" },
  { key: "lancamento", label: "Lançamento", short: "Lançamento", scope: "unit", track: "site", weight: 6, kind: "custom" },
  { key: "filmagem", label: "Filmagem", short: "Filmagem", scope: "unit", track: "marketing", weight: 4, kind: "custom", team: "filmagem" },
  { key: "estampas", label: "Estampas", short: "Estampas", scope: "unit", track: "marketing", weight: 4, kind: "custom", team: "ilustracao" },
  { key: "marketing", label: "Marketing do produto", short: "Marketing", scope: "unit", track: "marketing", weight: 4, kind: "custom", team: "marketing" },
];

export const STEP_BY_KEY: Record<string, StepDef> = Object.fromEntries(STEPS.map((s) => [s.key, s]));

export const TRACK_LABEL: Record<Track, string> = { desenvolvimento: "Desenvolvimento", operacao: "Operação", site: "Site", marketing: "Marketing" };

export const TEAM_LABEL: Record<string, string> = {
  importacao: "Importação",
  itapeva: "Itapeva",
  ecommerce: "E-commerce",
  filmagem: "Filmagem",
  ilustracao: "Ilustração",
  marketing: "Marketing",
};
