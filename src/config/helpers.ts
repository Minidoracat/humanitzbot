/**
 * Config helper functions — pure utilities for parsing environment variables.
 */

/** Parse a boolean environment variable. */
export function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined || val === '') return defaultValue;
  return val === 'true';
}

/**
 * Parse a PVP_DAYS spec into a weekday Set (0=Sun … 6=Sat), or null for "every day".
 * Accepts day names ("Mon,Wed,Fri" / "monday") and/or numeric days ("1,3,5").
 * Shared by the global config (process.env.PVP_DAYS) and the per-server config
 * factory (serverDef.pvpDays) so both parse PVP_DAYS identically.
 */
export function parsePvpDays(val: string | undefined): Set<number> | null {
  if (!val || val.trim() === '') return null; // null = every day
  const dayNames: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const days = new Set<number>();
  for (const part of val.split(',')) {
    const t = part.trim().toLowerCase();
    // Own-property check: a bare `t in dayNames` would also match inherited
    // Object keys ('constructor', 'toString', …) and push non-numbers into the Set.
    if (Object.hasOwn(dayNames, t)) days.add(dayNames[t] as number);
    else if (/^[0-6]$/.test(t)) days.add(parseInt(t, 10));
  }
  return days.size > 0 ? days : null;
}

/** Parse an HH:MM time string into total minutes from midnight. */
export function envTime(key: string): number {
  const val = process.env[key];
  if (val === undefined || val === '') return NaN;
  const parts = val.split(':');
  const h = parseInt(parts[0] ?? '', 10);
  const m = parts.length > 1 ? parseInt(parts[1] ?? '', 10) : 0;
  if (isNaN(h) || isNaN(m)) return NaN;
  return h * 60 + m;
}

/**
 * Compute the UTC-to-local offset in milliseconds for a given timezone.
 * Used by parseLogTimestamp to convert game-server log times to UTC.
 */
export function tzOffsetMs(utcDate: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(utcDate);

  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  let h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  if (h === '24') h = '00'; // midnight edge case
  const mn = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const s = parts.find((p) => p.type === 'second')?.value ?? '00';

  const localAsUtc = new Date(`${y}-${m}-${d}T${h}:${mn}:${s}Z`);
  return localAsUtc.getTime() - utcDate.getTime();
}
