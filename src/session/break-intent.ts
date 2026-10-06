import { parseNamedMinutes } from './duration.js'

// Only a whole, explicit command bypasses the model. Questions, negation,
// task titles and compound reports keep their normal dialogue route.
export function explicitBreakMinutes(text: string): number | null | undefined {
  const value = text.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!]+$/u, '').trim()
  const command = /^(?:(?:сейчас|теперь)\s+)?(?:(?:я\s+)?(?:беру\s+перерыв|ухожу\s+(?:на\s+перерыв|отдыхать)|иду\s+(?:на\s+перерыв|отдыхать))|перерыв)(?:\s+(?:на\s+)?(.+))?$/u.exec(value)
  if (!command) return undefined
  if (!command[1]) return null
  // Anchored duration grammar prevents "перерыв не нужен" and similar text
  // from being mistaken for a pause merely because it contains a time.
  if (!/^(?:полтора\s+часа|полчаса|час|\d{1,3}\s*(?:минут(?:а|ы)?|мин\.?|час(?:а|ов)?|ч)|(?:один|два|две|три|четыре|пять|десять|пятнадцать|двадцать|тридцать|сорок|шестьдесят)\s+(?:минут(?:а|ы)?|час(?:а|ов)?))$/u.test(command[1])) return undefined
  if (/^0+(?:\s|$)/u.test(command[1])) return undefined
  return parseNamedMinutes(command[1]) ?? undefined
}
