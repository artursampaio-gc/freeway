// Copia para uma planilha leve só os VALORES das abas que o Freeway usa da
// planilha "DB-Produtos e Estoque" (a original é pesada demais para o Google
// entregar em menos de 100 s, e o Freeway não consegue lê-la direto).
//
// O script fica NA PLANILHA LEVE e lê a original pelo ID. Quem instala só
// precisa ter acesso de leitura à original (não precisa ser o dono dela).
//
// Como instalar:
// 1. Crie uma planilha nova e vazia, ex.: "DB-Produtos e Estoque (leve, Freeway)",
//    e compartilhe com freeway@produto-491115.iam.gserviceaccount.com como Leitor.
// 2. NESSA planilha nova: Extensões > Apps Script, apague o que estiver lá e cole este código.
// 3. Rode exportarParaFreeway uma vez (autorize o acesso).
// 4. Acionadores (relógio à esquerda) > Adicionar acionador > exportarParaFreeway >
//    Baseado no tempo > Contador de horas > A cada hora.

const ORIGEM = "1M163GaiqGNwzqcBpk4SDhRICopu_jqm3qnc9P6nWmxI"; // DB-Produtos e Estoque
const ABAS = ["Depara WMS", "Estoque WMS", "Produtos"];

function exportarParaFreeway() {
  const destino = SpreadsheetApp.getActive();
  if (!destino) throw new Error("Cole o script dentro da planilha leve (Extensões > Apps Script nela).");
  if (destino.getId() === ORIGEM) throw new Error("Este script vai na planilha LEVE, não na original: ele apagaria as abas dela.");
  const origem = SpreadsheetApp.openById(ORIGEM);

  for (const nome of ABAS) {
    const aba = acharAba(origem, nome);
    const valores = aba.getDataRange().getValues();
    const alvo = destino.getSheetByName(nome) || destino.insertSheet(nome);
    alvo.clearContents();
    if (!valores.length) continue;
    garantirTamanho(alvo, valores.length, valores[0].length);
    alvo.getRange(1, 1, valores.length, valores[0].length).setValues(valores);
  }
}

// Acha a aba pelo nome, sem ligar para maiúsculas, espaços extras ou acentos.
function acharAba(planilha, nome) {
  const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const aba = planilha.getSheets().find((s) => norm(s.getName()) === norm(nome));
  if (!aba) throw new Error(`Aba "${nome}" não encontrada na original. Abas que existem: ${planilha.getSheets().map((s) => s.getName()).join(", ")}`);
  return aba;
}

function garantirTamanho(aba, linhas, colunas) {
  if (aba.getMaxRows() < linhas) aba.insertRowsAfter(aba.getMaxRows(), linhas - aba.getMaxRows());
  if (aba.getMaxColumns() < colunas) aba.insertColumnsAfter(aba.getMaxColumns(), colunas - aba.getMaxColumns());
}
