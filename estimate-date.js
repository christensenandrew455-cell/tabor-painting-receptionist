const WEEKDAYS = Object.freeze([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function localDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

function utcDateFromParts({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

function formatShortDate(date) {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${month}/${day}/${year}`;
}

function parseExplicitDate(text) {
  const numeric = text.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})\b/);
  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    let year = Number(numeric[3]);
    if (year < 100) year += 2000;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day
    ) return date;
  }

  const written = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{2}|\d{4}))?\b/i);
  if (written) {
    const monthNames = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    const month = monthNames.indexOf(written[1].toLowerCase()) + 1;
    const day = Number(written[2]);
    let year = written[3] ? Number(written[3]) : null;
    if (year !== null && year < 100) year += 2000;
    return { month, day, year };
  }

  return null;
}

export function resolveEstimateDate(value, { now = new Date() } = {}) {
  const text = clean(value).toLowerCase();
  if (!text) return '';

  const todayParts = localDateParts(now);
  const today = utcDateFromParts(todayParts);

  const explicit = parseExplicitDate(text);
  if (explicit instanceof Date) {
    return explicit < today ? '' : formatShortDate(explicit);
  }
  if (explicit && explicit.month && explicit.day) {
    let year = explicit.year ?? todayParts.year;
    let date = new Date(Date.UTC(year, explicit.month - 1, explicit.day));
    if (Number.isNaN(date.getTime())) return '';
    if (explicit.year === null && date < today) {
      year += 1;
      date = new Date(Date.UTC(year, explicit.month - 1, explicit.day));
    }
    return date < today ? '' : formatShortDate(date);
  }

  if (/\btoday\b/.test(text)) return formatShortDate(today);
  if (/\btomorrow\b/.test(text)) {
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return formatShortDate(tomorrow);
  }

  const weekdayMatch = text.match(/\b(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (weekdayMatch) {
    const target = WEEKDAYS.indexOf(weekdayMatch[1].toLowerCase());
    const current = today.getUTCDay();
    let daysAhead = (target - current + 7) % 7;
    const explicitlyNext = /\bnext\s+/.test(weekdayMatch[0].toLowerCase());
    if (daysAhead === 0 || explicitlyNext) daysAhead += 7;
    const resolved = new Date(today);
    resolved.setUTCDate(resolved.getUTCDate() + daysAhead);
    return formatShortDate(resolved);
  }

  return '';
}
