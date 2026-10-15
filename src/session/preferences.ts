import { restFor } from './duration.js'
import { PRESETS, isTechnique } from './technique.js'

// Defaults select future periods only; saving them never edits a running timer.
type Preferences = { defaultWorkMinutes: number | null; defaultRestMinutes: number | null }
export const preferredWork = (user: Preferences, fallback: number | null): number | null => user.defaultWorkMinutes ?? fallback
export function preferredRest(user: Preferences, fallback: number): number
export function preferredRest(user: Preferences, fallback: number | null): number | null
export function preferredRest(user: Preferences, fallback: number | null): number | null { return user.defaultRestMinutes ?? fallback }

// A changed work default must not carry the old auto-rest into a new period.
// Keep a previous one-off rest if work did not change (its source is unknown).
export function nextPeriodRest(user: Preferences, previous: { plannedMinutes: number | null; plannedRestMinutes: number | null; technique: string | null } | null, minutes: number | null): number {
  const technique = previous?.technique
  const fallback = technique && isTechnique(technique) && technique !== 'auto' ? PRESETS[technique].rest : restFor(minutes)
  return preferredRest(user, previous && previous.plannedMinutes === minutes ? previous.plannedRestMinutes ?? fallback : fallback)
}
