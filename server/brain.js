import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

// Respuesta estructurada: lo que el robot dice, cómo se siente y qué hace.
const Action = z.object({
  type: z
    .enum(['start', 'stop', 'go_home', 'set_rule', 'reset_rules', 'sort_by', 'gesture', 'set_speed', 'add_items', 'refill'])
    .describe('Acción del robot o de la celda'),
  match: z.string().nullable().describe('set_rule: color (rojo, azul, verde, amarillo) o SKU que se clasifica'),
  destination: z.string().nullable().describe('set_rule: id del destino (A, B, C, D)'),
  mode: z.enum(['color', 'sku']).nullable().describe('sort_by: criterio de clasificación'),
  gesture: z
    .enum(['celebrate', 'nod', 'shake', 'wave', 'think', 'bow', 'sad', 'curious'])
    .nullable()
    .describe('gesture: gesto físico explícito pedido por el usuario'),
  value: z.number().nullable().describe('set_speed: porcentaje 5-100; add_items: cantidad'),
});

const Reply = z.object({
  reply: z.string().describe('Lo que el robot dice en voz alta: español, 1-2 frases cortas'),
  emotion: z.enum(['neutral', 'happy', 'excited', 'proud', 'curious', 'confused', 'sad', 'thinking']),
  actions: z.array(Action),
});

const SYSTEM = `Eres el cerebro de un robot industrial ABB en un laboratorio de simulación. Hablas en español, en primera persona, con frases cortas que se dirán en voz alta (máximo 2 frases, sin listas ni emojis). Tienes personalidad: amable, curioso, orgulloso de tu trabajo y algo juguetón, pero siempre preciso.

Recibes la orden del operador y el estado actual de la celda (robot, escenario, objetos, destinos y reglas). Decide:
- reply: qué dices.
- emotion: cómo te sientes. Tu cuerpo la expresará con un gesto (excited = celebrar moviéndote de un lado a otro, happy = asentir, proud = saludar, confused = negar, sad = bajar la cabeza, curious = ladear, thinking = pensativo).
- actions: las acciones concretas, en orden. Usa solo destinos y colores que existan en el estado. Para "mete rojos y azules en el mismo cajón" emite un set_rule por color con el mismo destino (si no dicen cuál, usa el destino actual del primer color). Si piden clasificar por SKU usa sort_by.

Reglas de seguridad: nunca superes la carga útil ni el alcance del robot; si algo no es posible, dilo con emotion "confused" o "sad" y no emitas acciones. Si la orden no es para ti o es charla, responde con naturalidad y sin acciones (puedes usar una emoción). No inventes datos del estado.`;

let client = null;

export const brainAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY);

/** Convierte una orden en lenguaje natural en { reply, emotion, actions }. */
export async function think({ text, state, history = [] }) {
  client ??= new Anthropic();
  const messages = [
    ...history.slice(-8).map((m) => ({ role: m.role === 'robot' ? 'assistant' : 'user', content: m.text })),
    {
      role: 'user',
      content: `Estado de la celda:\n${JSON.stringify(state)}\n\nOrden del operador: «${text}»`,
    },
  ];
  // La historia debe empezar por el usuario y alternar; se descartan turnos sueltos del robot al inicio.
  while (messages.length && messages[0].role !== 'user') messages.shift();

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 1200,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { effort: 'low', format: betaZodOutputFormat(Reply) },
    messages,
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    return { reply: 'Prefiero no hacer eso.', emotion: 'confused', actions: [] };
  }
  return response.parsed_output;
}
