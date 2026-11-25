import type { DB } from "../env";
import { todayBR } from "../db/q";
import type { LaunchCard, StepView } from "../shared/types";
import { devProjects, markWatching } from "./dev";
import { loadViews } from "./view";
import { launchMonth } from "../shared/months";

// Aba Galeria: os lançamentos abertos dos quadros Launches, em lista, agrupados pelo mês de lançamento
// (o grupo do item no Monday), com foto e as linhas de status de cada um.

export { launchMonth } from "../shared/months";

export async function launchGallery(db: DB, user: string): Promise<{ cards: LaunchCard[]; month: string }> {
  const projects = await markWatching(db, await devProjects(db), user);
  // Lançamento que já virou pedido: as linhas de Operação, Site e Marketing vêm do pedido (primeiro frete).
  const codes = [...new Set(projects.flatMap((p) => p.info.process_codes))];
  const views = new Map((await loadViews(db, codes, user)).map((v) => [v.process_code, v]));
  const cards = projects.map((p): LaunchCard => {
    const order = p.info.process_codes.map((c) => views.get(c)).find(Boolean) ?? null;
    const unit = order?.units[0] ?? null;
    const later: StepView[] = unit ? unit.steps.filter((s) => s.track !== "desenvolvimento") : [];
    const pk = p.skus.rows.find((r) => r.goproduct_pk)?.goproduct_pk ?? null;
    const img = p.galeria?.fotos[0] ?? (pk ? `/api/goproduct/img/${pk}` : null) ?? (unit?.items.find((i) => i.goproduct_img)?.goproduct_img ?? order?.items.find((i) => i.goproduct_img)?.goproduct_img ?? null);
    return {
      item_id: p.info.item_id,
      name: p.info.name,
      month: launchMonth(p.info.launch_group),
      group: p.info.launch_group,
      board: p.info.board,
      stage: p.info.stage,
      launch_status: p.info.launch_status,
      tipo: p.info.tipo,
      people: p.info.people,
      process_codes: p.info.process_codes,
      health: p.health,
      total: p.total,
      current: p.current,
      steps: [...p.steps, ...later],
      img,
      watching: !!p.watching,
      mine: p.info.emails.includes(user.toLowerCase()),
    };
  });
  return { cards, month: todayBR().slice(0, 7) };
}
