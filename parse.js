// Turns "Interview Oct 27 at 7am, start reminding me Oct 26 at 7pm, every hour"
// into { title, start, nagStart, every, level }. Dates come back as Date objects.
// `chrono` is the chrono-node library, passed in so this file has no imports.

const MUST = /\b(can'?t miss|cannot miss|must|important|urgent|interview|appointment|deadline|exam|test|court|flight)\b/i;
const REMIND = /(remind(ing)?( me)?|reminders?|nag( me)?|start)\W*(\w+\W+){0,2}$/i;

export function everyFromText(text) {
  const t = text.toLowerCase();
  if (/every\s+half\s+(an\s+)?hour/.test(t)) return 30;
  let m = t.match(/every\s+(\d+)\s*(minutes?|mins?)\b/);
  if (m) return Number(m[1]);
  m = t.match(/every\s+(\d+|two|three|four)\s*(hours?|hrs?)\b/);
  if (m) return ({ two: 2, three: 3, four: 4 }[m[1]] || Number(m[1])) * 60;
  if (/every\s+(hour|hr)\b|hourly/.test(t)) return 60;
  return null;
}

export function parseRequest(text, now, chrono) {
  // "every 2 hours" is a repeat, not a date
  const results = chrono.parse(text, now, { forwardDate: true })
    .filter((r) => !/every\s*$/i.test(text.slice(0, r.index)));
  let event = null, nag = null;
  for (const r of results) {
    const before = text.slice(Math.max(0, r.index - 30), r.index);
    if (!nag && event && REMIND.test(before)) nag = r;
    else if (!nag && !event && REMIND.test(before) && results.length > 1) nag = r;
    else if (!event) event = r;
  }

  let start = null;
  if (event) {
    start = event.start.date();
    if (!event.start.isCertain("hour")) start.setHours(9, 0, 0, 0);
  }

  let nagStart = null;
  if (nag) {
    nagStart = nag.start.date();
    // "remind me at 1pm" with no day means the event's day
    if (start && !nag.start.isCertain("day")) {
      nagStart = new Date(start);
      nagStart.setHours(nag.start.get("hour"), nag.start.get("minute") || 0, 0, 0);
    }
    // "remind me at 8:30" for a 9pm event means 8:30pm
    if (start && !nag.start.isCertain("meridiem") && start - nagStart > 12 * 3600000) nagStart = new Date(nagStart.getTime() + 12 * 3600000);
    // a reminder time that lands after the event usually meant the day before
    if (start && nagStart >= start && !nag.start.isCertain("day")) nagStart = new Date(nagStart - 86400000);
    if (start && nagStart.getFullYear() > start.getFullYear()) nagStart.setFullYear(start.getFullYear());
  }

  const mustDo = MUST.test(text);
  const saidEvery = everyFromText(text);
  let level = mustDo ? "cantmiss" : "normal";
  let every = saidEvery ?? (nag && !saidEvery ? 0 : mustDo ? 60 : 120);
  if (saidEvery === 60 || saidEvery === 30) level = "cantmiss";
  if (every === 0) level = "light";
  if (start && !nagStart) nagStart = new Date(start - (level === "cantmiss" ? 12 : 4) * 3600000);

  // Title: what's left after removing the dates and reminder talk
  let title = text;
  for (const r of results) title = title.replace(r.text, " ");
  title = title
    .replace(/\b(start\s+)?remind(ing)?\s+me\b/gi, " ")
    .replace(/\breminders?\b|\bnag me\b/gi, " ")
    .replace(/\bevery\s+(half\s+(an\s+)?hour|\d+\s*(minutes?|mins?|hours?|hrs?)|(two|three|four)\s+hours?|hour|hr)\b|\bhourly\b/gi, " ")
    .replace(/\b(i\s+)?(can'?t|cannot)\s+miss(\s+it)?\b/gi, " ")
    .replace(/\b(i have|i've got|i got|i need to|i gotta|gotta|need to)\b/gi, " ")
    .replace(/\s+\b(at|on|by|from|starting|until|and|then)\b(?=\s*[,.]?\s*$)/gi, " ")
    .replace(/[,.;]+/g, " ")
    .replace(/\s+\b(at|on|by|from|starting|until|and|then)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  title = title.replace(/\s+\b(at|on|by|from|and|every)$/i, "").replace(/^(an?|the)\s+/i, "").trim();
  if (title) title = title[0].toUpperCase() + title.slice(1);

  return { title: title || text.trim(), start, nagStart, every, level };
}
