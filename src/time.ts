/** Time zone helpers (from LensMap's lib/tz.ts) and the demo clock.
 *
 * The demo runs on a fixed date so that recorded answers stay valid and the
 * sample events never drift into the past. The viewer only picks the time of
 * day; everything else ("today", "this Saturday", the 48-hour horizon) is
 * computed from DEMO_DATE in the city's time zone. */

export const DEMO_DATE = process.env.DEMO_DATE ?? '2026-10-09'

/** Zone offset in minutes at `at` (positive east of UTC). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((asUtc - at.getTime()) / 60000)
}

/** Local date + time -> Date (UTC). null for garbage. */
export function localToDate(date: string, time: string | null, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!m) return null
  const t = /^(\d{1,2}):(\d{2})/.exec((time ?? '').trim())
  const h = t ? Number(t[1]) : 12
  const mi = t ? Number(t[2]) : 0
  if (h > 23 || mi > 59) return null
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi)
  if (!Number.isFinite(guess)) return null
  const d = new Date(guess - tzOffsetMinutes(tz, new Date(guess)) * 60000)
  return Number.isNaN(d.getTime()) ? null : d
}

/** A real calendar date in YYYY-MM-DD form ("2026-10-32" is not). */
export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return y >= 2000 && y <= 2100 && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

/** The date if it is real and within `days` of the demo date, else the demo
 * date itself: a publication date from the client must not make the server
 * build a calendar from the year 0001. */
export function nearDemoDate(s: string, days = 60): string {
  if (!isRealDate(s)) return DEMO_DATE
  return Math.abs(Date.parse(s) - Date.parse(DEMO_DATE)) <= days * 86400000 ? s : DEMO_DATE
}

/** "Now" of the demo: DEMO_DATE at the scenario's local time. */
export function demoNow(time: string, tz: string): Date {
  return localToDate(DEMO_DATE, time, tz) ?? new Date()
}

/** YYYY-MM-DD of a moment in the given zone. */
export function localDay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d)
}

export function fmtWhen(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  }).format(d)
}

export function fmtDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(d)
}

export function fmtNow(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  }).format(d)
}
