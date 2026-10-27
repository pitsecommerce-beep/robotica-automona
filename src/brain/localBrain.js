import { normalize, COLORS } from '../scenarios/Scenario.js';

const COLOR_WORDS = {
  rojo: /\broj[oa]s?\b/,
  azul: /\bazul(es)?\b/,
  verde: /\bverdes?\b/,
  amarillo: /\bamarill[oa]s?\b/,
};

/**
 * Intérprete local de órdenes en español. Es la vía rápida (respuesta inmediata para órdenes
 * claras, sin esperar a la nube) y el respaldo cuando no hay Claude configurado.
 * Devuelve { reply, emotion, actions, confident }.
 */
export function interpretLocally(text, state) {
  const t = normalize(text);
  const out = (reply, emotion, actions = [], confident = true) => ({ reply, emotion, actions, confident });
  const destIds = (state?.destinations ?? []).map((d) => d.id);

  if (!t) return out('No te he oído bien.', 'confused', [], false);

  // Parar tiene prioridad: es una orden de seguridad.
  if (/^(para|alto|stop|detente|deten|quieto)\b|\bdetente\b|\bdeten(te)? (la|el|todo)|\bpara (ya|todo|la demo|de trabajar)/.test(t)) {
    return out('Me detengo.', 'neutral', [{ type: 'stop' }]);
  }

  const colors = Object.keys(COLOR_WORDS).filter((c) => COLOR_WORDS[c].test(t));
  const letter = t.match(/\b(?:cajon|caja|pale|palet|destino|zona)\s+([a-d])\b/)?.[1]?.toUpperCase();
  const toColorBin = t.match(/\b(?:cajon|caja|pale|palet|destino|zona)\s+(?:del?\s+)?(rojo|azul|verde|amarillo)\b/)?.[1];

  // Reglas: "mete los rojos y azules en el mismo cajón", "los verdes al cajón A".
  if (colors.length && /\b(mete|pon|poner|lleva|manda|envia|deja|clasifica|separa|junta|agrupa|guarda|coloca|acomoda)\b/.test(t)) {
    const findByColor = (c) => state?.destinations?.find((d) => d.color === c)?.id;
    let dest = letter ?? (toColorBin ? findByColor(toColorBin) : null);
    const ruleColors = toColorBin && !letter ? colors.filter((c) => c !== toColorBin || colors.length === 1) : colors;
    if (!dest && /\bmismo\b|\bjunt[oa]s\b/.test(t)) dest = state?.rules?.[colors[0]] ?? findByColor(colors[0]);
    if (dest && destIds.includes(dest)) {
      const actions = ruleColors.map((c) => ({ type: 'set_rule', match: c, destination: dest }));
      const plural = { rojo: 'rojos', azul: 'azules', verde: 'verdes', amarillo: 'amarillos' };
      const names = ruleColors.map((c) => plural[c]).join(' y ');
      return out(`Entendido: ${names} al destino ${dest}.`, 'happy', actions);
    }
  }

  if (/\bpor sku\b|\bpor referencia\b|\bpor codigo\b/.test(t)) return out('Clasifico por SKU.', 'happy', [{ type: 'sort_by', mode: 'sku' }]);
  if (/\bpor colou?r(es)?\b/.test(t)) return out('Clasifico por color.', 'happy', [{ type: 'sort_by', mode: 'color' }]);
  if (/\b(reinicia|restablece|resetea|borra)\b.*\breglas?\b/.test(t)) return out('Reglas restablecidas.', 'neutral', [{ type: 'reset_rules' }]);

  if (/\b(inicia|iniciar|empieza|empezar|comienza|arranca|arrancar|ponte a trabajar|a trabajar|demostracion|demo)\b/.test(t)) {
    return out('¡Vamos allá! Empiezo.', 'excited', [{ type: 'start' }]);
  }
  if (/\b(home|casa|posicion inicial|reposo|descansa)\b/.test(t)) return out('Vuelvo a mi posición de reposo.', 'neutral', [{ type: 'go_home' }]);
  if (/\b(repon|rellena|recarga|reinicia)\b.*\b(pale|palet|cajas)\b/.test(t)) return out('Repongo el palé.', 'happy', [{ type: 'refill' }]);

  const n = t.match(/\b(\d+)\s+(paquetes|cajas|piezas)\b/);
  if (n && /\b(anade|agrega|pon|mete|trae|genera)\b/.test(t)) {
    return out(`Añado ${n[1]} paquetes a la línea.`, 'happy', [{ type: 'add_items', value: Number(n[1]) }]);
  }

  const pct = t.match(/\b(\d{1,3})\s*(%|por ?ciento)/);
  if (pct && /velocidad|rapido|lento/.test(t)) return out(`Velocidad al ${pct[1]} %.`, 'neutral', [{ type: 'set_speed', value: Number(pct[1]) }]);
  if (/\bmas rapido\b|\bacelera\b/.test(t)) return out('Subo la velocidad.', 'excited', [{ type: 'set_speed', value: 100 }]);
  if (/\bmas (lento|despacio)\b|\bfrena\b/.test(t)) return out('Voy más despacio.', 'neutral', [{ type: 'set_speed', value: 40 }]);

  if (/\b(celebra|baila|festeja)\b/.test(t)) return out('¡Yuju!', 'excited', [{ type: 'gesture', gesture: 'celebrate' }]);
  if (/\b(saluda|hola|buenas|buenos dias|buenas tardes)\b/.test(t)) return out('¡Hola! Estoy listo para trabajar.', 'proud', [{ type: 'gesture', gesture: 'wave' }], false);
  if (/\b(bien hecho|genial|excelente|buen trabajo|gracias)\b/.test(t)) return out('¡Gracias! Me encanta mi trabajo.', 'excited', [], false);

  return out('No estoy seguro de qué quieres que haga.', 'confused', [], false);
}

export const KNOWN_COLORS = Object.keys(COLORS);
