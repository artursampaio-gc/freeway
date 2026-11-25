import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

// Ícones de traço (24×24, estilo Lucide), desenhados com currentColor.
interface IconDef {
  d: string[];
  c?: [number, number, number][];
}

const ICONS: Record<string, IconDef> = {
  check: { d: ["M20 6 9 17l-5-5"] },
  x: { d: ["M18 6 6 18", "M6 6l12 12"] },
  pencil: { d: ["M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z", "m15 5 4 4"] },
  reopen: { d: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"] },
  ban: { d: ["m4.9 4.9 14.2 14.2"], c: [[12, 12, 10]] },
  play: { d: ["M6 3l14 9-14 9V3z"] },
  pause: { d: ["M10 15V9", "M14 15V9"], c: [[12, 12, 10]] },
  paperclip: { d: ["m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"] },
  refresh: { d: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"] },
  arrowRight: { d: ["M5 12h14", "m12 5 7 7-7 7"] },
  arrowDown: { d: ["M12 5v14", "m19 12-7 7-7-7"] },
  chevronRight: { d: ["m9 18 6-6-6-6"] },
  chevronDown: { d: ["m6 9 6 6 6-6"] },
  chevronLeft: { d: ["m15 18-6-6 6-6"] },
  star: { d: ["M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"] },
  calendar: { d: ["M8 2v4", "M16 2v4", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M3 10h18"] },
  checkCheck: { d: ["M18 6 7 17l-5-5", "m22 10-7.5 7.5L13 16"] },
  checkCircle: { d: ["m9 12 2 2 4-4"], c: [[12, 12, 10]] },
  circle: { d: [], c: [[12, 12, 10]] },
  clock: { d: ["M12 6v6l4 2"], c: [[12, 12, 10]] },
  search: { d: ["m21 21-4.3-4.3"], c: [[11, 11, 8]] },
  external: { d: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"] },
  plus: { d: ["M5 12h14", "M12 5v14"] },
  upload: { d: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m17 8-5-5-5 5", "M12 3v12"] },
  eye: { d: ["M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"], c: [[12, 12, 3]] },
  send: { d: ["m22 2-7 20-4-9-9-4Z", "M22 2 11 13"] },
  bell: { d: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"] },
  pin: { d: ["M12 17v5", "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"] },
  flag: { d: ["M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z", "M4 22v-7"] },
  bulb: { d: ["M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5", "M9 18h6", "M10 22h4"] },
  gear: { d: ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"], c: [[12, 12, 3]] },
};

export type IconName = keyof typeof ICONS;

/** filled: preenchido (ex.: o pin de quem já segue). */
export function Icon({ name, spin = false, filled = false }: { name: IconName; spin?: boolean; filled?: boolean }) {
  const def = ICONS[name];
  return html`<svg class=${"icon" + (spin ? " spin" : "")} viewBox="0 0 24 24" fill=${filled ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${def.d.map((d) => html`<path d=${d} />`)}
    ${(def.c ?? []).map(([cx, cy, r]) => html`<circle cx=${cx} cy=${cy} r=${r} />`)}
  </svg>`;
}

/** Botão só com ícone; a explicação aparece no tooltip e é lida por leitores de tela. */
export function IconBtn({
  icon,
  tip,
  onClick,
  variant = "",
  disabled = false,
  type = "button",
  spin = false,
  filled = false,
}: {
  icon: IconName;
  tip: string;
  onClick?: (e: any) => void;
  variant?: string;
  disabled?: boolean;
  type?: string;
  spin?: boolean;
  filled?: boolean;
}) {
  return html`<button type=${type} class=${`icon-btn ${variant}`.trim()} data-tip=${tip} aria-label=${tip} disabled=${disabled} onClick=${onClick}>
    <${Icon} name=${icon} spin=${spin} filled=${filled} />
  </button>`;
}

/** Ícone de IA com as cores girando, para chamar atenção às leituras da IA. */
export function AiIcon({ tip = "Sugerido pela IA a partir de tudo o que o Freeway sabe do pedido" }: { tip?: string }) {
  return html`<span class="ai-icon" role="img" aria-label=${tip} data-tip=${tip}></span>`;
}
