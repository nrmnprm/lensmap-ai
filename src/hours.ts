/** "Open now" from the OSM opening_hours tag, evaluated at the demo clock.
 * Same approach as LensMap: the library works in the process's local time,
 * so the moment is shifted by the city's offset first. */
import opening_hours from 'opening_hours'
import { tzOffsetMinutes } from './time.ts'

export interface OpenState {
  open: boolean
  /** Local time of the next change ("HH:MM"), when it is within 24 hours. */
  changesAt: string | null
}

export function openState(openingHours: string | null, tz: string, now: Date): OpenState | null {
  if (!openingHours) return null
  try {
    const oh = new opening_hours(openingHours)
    const offsetMin = tzOffsetMinutes(tz, now) + now.getTimezoneOffset()
    const shifted = new Date(now.getTime() + offsetMin * 60000)
    const open = oh.getState(shifted)
    const next = oh.getNextChange(shifted)
    let changesAt: string | null = null
    if (next && next.getTime() - shifted.getTime() < 24 * 3600 * 1000) {
      changesAt = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
    }
    return { open, changesAt }
  } catch {
    return null
  }
}

/** "open until 22:00" / "closed, opens at 09:00" / "" when unknown. */
export function openLabel(openingHours: string | null, tz: string, now: Date): string {
  const st = openState(openingHours, tz, now)
  if (!st) return ''
  if (st.open) return st.changesAt ? `open until ${st.changesAt}` : 'open'
  return st.changesAt ? `closed, opens at ${st.changesAt}` : 'closed'
}
