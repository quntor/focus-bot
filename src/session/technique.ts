// Техники — именованные наборы адаптируемых параметров: длина сессии, отдыха и
// наличие пинга. На правила очков, серии и «завершённой сессии» не влияют.
export const TECHNIQUE_IDS = ['auto', 'pomodoro', 'medium', 'long', 'free'] as const
export type Technique = (typeof TECHNIQUE_IDS)[number]

type Preset = {
  // null — без планового конца (свободный режим).
  minutes: number | null
  rest: number
  // Когда пинговать: mid — в середине, every — каждые N минут, none — никогда.
  ping: { kind: 'mid' } | { kind: 'every'; minutes: number } | { kind: 'none' }
}

export const PRESETS: Record<Exclude<Technique, 'auto'>, Preset> = {
  pomodoro: { minutes: 25, rest: 5, ping: { kind: 'none' } },
  medium: { minutes: 50, rest: 10, ping: { kind: 'mid' } },
  long: { minutes: 90, rest: 20, ping: { kind: 'mid' } },
  free: { minutes: null, rest: 10, ping: { kind: 'every', minutes: 30 } },
}

export function isTechnique(value: string): value is Technique {
  return (TECHNIQUE_IDS as readonly string[]).includes(value)
}
