// Simula o AI Proxy nos testes locais: responde no mesmo formato da API real
// com um JSON montado a partir do texto recebido.
export const aiCalls: { system: string; user: string }[] = [];

export function installFakeAi() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://ai-proxy.gogroupbr.com/")) return realFetch(input, init);
    const body = JSON.parse(String(init?.body));
    const system = body.messages[0].content;
    const user = body.messages[1].content as string;
    aiCalls.push({ system, user: typeof user === "string" ? user : String((user as any)[0]?.text ?? "") });
    if (system.includes("assistente do Freeway")) {
      // Aba Perguntar: pergunta sobre Itapeva consulta as OPs; com resultado na mão, responde; senão diz o que veio no contexto.
      const msgs = body.messages as { role: string; content: string }[];
      const last = msgs[msgs.length - 1].content;
      const ctx = String(msgs[1].content);
      const detailed = [...ctx.matchAll(/^## ((?:GOC|BBI)\d{5})/gm)].map((m) => m[1]);
      let reply: unknown;
      if (last.startsWith("Resultado de")) reply = { acao: "responder", texto: `Com base em: ${last.split("\n")[1] ?? ""}` };
      else if (/itapeva/i.test(last)) reply = { acao: "consultar", ferramenta: "itapeva_ordens", argumentos: { item: "TX221004BR", status: "em_producao,concluido" } };
      else reply = { acao: "responder", texto: `Detalhes recebidos: ${detailed.join(", ") || "nenhum"}` };
      return new Response(JSON.stringify({ model: "fake-latest", choices: [{ message: { role: "assistant", content: JSON.stringify(reply) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (system.includes("Warehouse Samples")) {
      // Amostra: escolhe o 1º candidato; com "VOYAGE" no nome a confiança é alta, senão fica para confirmar.
      const text = typeof user === "string" ? user : String((user as any)[0]?.text ?? "");
      const first = text.match(/^- ((?:GOC|BBI)\d{5})/m)?.[1];
      const content = JSON.stringify({ processos: first ? [first] : [], confianca: /VOYAGE/i.test(text) ? 0.9 : 0.5, evidencia: "teste" });
      return new Response(JSON.stringify({ model: "fake-latest", choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 50 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const code = user.match(/Processo (\w+)/)?.[1];
    const embarques: Record<string, string> = {};
    for (const m of user.matchAll(/^- ((?:GOC|BBI)\d{5}\.\d+) · ([^·\n]+)/gm)) embarques[m[1]] = `${m[2].trim()} (lido pela IA de teste)`;
    const first = Object.keys(embarques)[0] ?? null;
    const fedex = user.match(/fedex\s*:?\s*(\d{12})/i)?.[1];
    const content = JSON.stringify({
      resumo: `${code}: resumo de teste com ${Object.keys(embarques).length} embarque(s) em aberto.`,
      atencao: first ? `${first} com ETA postergado` : null,
      embarques,
      pendencias: first ? [{ texto: "Acompanhar o motivo da postergação do ETA", embarque: first, responsavel: "importacao" }] : [],
      rastreios: fedex ? [{ codigo: fedex, transportadora: "FedEx", contexto: "amostra" }] : [],
    });
    return new Response(
      JSON.stringify({ model: "fake-latest", choices: [{ message: { role: "assistant", content: "```json\n" + content + "\n```" } }], usage: { total_tokens: 123 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}
