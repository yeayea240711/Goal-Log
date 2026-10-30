/**
 * Goal Log: tasks on Google Sheets, reminder emails from Gmail.
 *
 * Setup (once):
 *  1. Create a new Google Sheet named "Goal Log".
 *  2. In the Sheet: Extensions > Apps Script. Delete what's there, paste this whole file, and save.
 *  3. Change PASSCODE below to a passcode only you know. You'll type it to sign in.
 *  4. Put your site's link in SITE_URL so reminder emails can link back to it.
 *  5. In the function menu at the top, pick setup and press Run. Allow the permissions Google asks for.
 *     It starts the reminder check (every 5 minutes) and the morning plan email.
 *  6. Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone. Deploy.
 *  7. Copy the Web app URL into config.js (googleScriptUrl).
 *
 * Reminders go to EMAIL (left blank, that's the Google account that runs this script).
 * Times in emails use this script's time zone: Project Settings (gear) > Time zone.
 */

const PASSCODE = 'change-me';
const EMAIL = '';
const SITE_URL = 'https://yeayea240711.github.io/goal-log/';
const MORNING_HOUR = 7;      // the "today's plan" email, in the script's time zone. Set to -1 to turn it off.
const ASK_AFTER_MIN = 60;    // this long after a task's time, you get a "did you do it?" email

const SHEET_NAME = 'Tasks';
const COLS = ['When', 'Task', 'Level', 'Status', 'Why missed', 'Remind from', 'Every (min)',
  'id', 'start_at', 'nag_at', 'last_emailed', 'asked', 'Created', 'Updated'];
const LEVELS = ['light', 'normal', 'cantmiss'];

// ---------- web entry points ----------
function doGet(e) {
  return json_({ data: { ok: true, name: 'Goal Log' } });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: { message: 'Bad request.' } }); }
  try {
    const fn = ACTIONS[body.action];
    if (!fn) return json_({ error: { message: 'Unknown action.' } });
    signedIn_(body);
    return json_({ data: withLock_(() => fn(body)) });
  } catch (err) {
    return json_({ error: { code: err.code || null, message: err.message || String(err) } });
  }
}

const ACTIONS = {
  check: () => ({ ok: true, email: to_() }),

  list: () => readAll_().map(public_),

  save: b => {
    const t = b.task || {};
    const title = cut_(t.title, 200);
    const start = toMs_(t.start_at);
    if (!title) throw err_('Give the task a name.');
    if (!start) throw err_('Pick when it happens.');
    const nag = t.nag_at ? toMs_(t.nag_at) : null;
    const every = Math.max(0, Math.min(1440, Number(t.every) || 0));
    const level = LEVELS.indexOf(t.level) >= 0 ? t.level : 'normal';
    const now = iso_(Date.now());
    let r = t.id ? readAll_().find(x => x.id === t.id) : null;
    if (t.id && !r) throw err_('That task was deleted.');
    if (!r) r = { id: Utilities.getUuid(), status: 'open', reason: '', last_emailed: '', asked: '', created: now };
    // a new time means the reminders start over
    if (r.start_at !== iso_(start) || String(r.nag_at || '') !== (nag ? iso_(nag) : '') || Number(r.every) !== every) {
      r.last_emailed = ''; r.asked = '';
    }
    Object.assign(r, { title, start_at: iso_(start), nag_at: nag ? iso_(nag) : '', every, level, updated: now });
    save_(r);
    return public_(r);
  },

  status: b => {
    const r = readAll_().find(x => x.id === b.id);
    if (!r) throw err_('That task was deleted.');
    if (['open', 'done', 'missed'].indexOf(b.status) < 0) throw err_('Unknown status.');
    r.status = b.status;
    r.reason = b.status === 'missed' ? cut_(b.reason, 500) : '';
    r.updated = iso_(Date.now());
    save_(r);
    return public_(r);
  },

  remove: b => {
    const r = readAll_().find(x => x.id === b.id);
    if (r) sheet_().deleteRow(r._row);
    return { ok: true };
  },

  test_email: () => {
    MailApp.sendEmail({ to: to_(), subject: 'Goal Log: test reminder',
      htmlBody: wrap_('<p>Reminder emails are working. You\'ll get these on your phone wherever Gmail is signed in.</p>') });
    return { ok: true, email: to_() };
  }
};

// ---------- setup + timed jobs ----------
// Run once from the editor. Starts the reminder check and the morning email.
function setup() {
  sheet_();
  ScriptApp.getProjectTriggers()
    .filter(t => ['checkReminders', 'morningPlan'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkReminders').timeBased().everyMinutes(5).create();
  if (MORNING_HOUR >= 0) ScriptApp.newTrigger('morningPlan').timeBased().atHour(MORNING_HOUR).everyDays(1).create();
  Logger.log('Goal Log is set up. Reminders go to ' + to_());
}

// Every 5 minutes: send the reminder that's due, and ask about tasks whose time has passed.
function checkReminders() {
  withLock_(() => {
    const now = Date.now();
    readAll_().forEach(r => {
      if (r.status !== 'open') return;
      const start = toMs_(r.start_at);
      if (!start) return;

      if (now >= start + ASK_AFTER_MIN * 60000) {
        if (!r.asked) {
          email_('ask', r);
          r.asked = iso_(now);
          save_(r);
        }
        return;
      }

      const due = slots_(r).filter(t => t <= now);
      if (!due.length) return;
      const latest = due[due.length - 1];
      const last = toMs_(r.last_emailed) || 0;
      // skip one that's gone stale (the script was paused), but never skip the "starting now" one
      if (latest <= last || (now - latest > 30 * 60000 && latest !== start)) return;
      email_(latest === start ? 'now' : 'reminder', r);
      r.last_emailed = iso_(latest);
      save_(r);
    });
  });
}

// Each morning: today's tasks and anything still waiting for an answer.
function morningPlan() {
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const all = readAll_();
  const todays = all.filter(r => r.status === 'open' && Utilities.formatDate(new Date(toMs_(r.start_at)), tz, 'yyyy-MM-dd') === today)
    .sort((a, b) => toMs_(a.start_at) - toMs_(b.start_at));
  const waiting = all.filter(r => r.status === 'open' && toMs_(r.start_at) < Date.now() - ASK_AFTER_MIN * 60000);
  if (!todays.length && !waiting.length) return;
  let html = '';
  if (todays.length) html += '<h3 style="margin:0 0 8px">Today</h3><ul>' + todays.map(r => '<li><b>' + time_(r.start_at) + '</b> ' + esc_(r.title) + (r.level === 'cantmiss' ? ' <span style="color:#b13a2d">(can\'t miss)</span>' : '') + '</li>').join('') + '</ul>';
  if (waiting.length) html += '<h3 style="margin:16px 0 8px">Still waiting on an answer</h3><ul>' + waiting.map(r => '<li>' + esc_(r.title) + ' (' + when_(r.start_at) + ')</li>').join('') + '</ul>';
  MailApp.sendEmail({ to: to_(), subject: 'Today: ' + (todays.length ? todays.length + ' task' + (todays.length > 1 ? 's' : '') : 'nothing scheduled'), htmlBody: wrap_(html) });
}

// ---------- reminder schedule ----------
// The reminder times for a task: from nag_at, every `every` minutes, until it starts, plus the start itself.
function slots_(r) {
  const start = toMs_(r.start_at), nag = toMs_(r.nag_at), every = Number(r.every) || 0;
  const out = [];
  if (nag && nag < start) {
    if (every > 0) for (let t = nag; t < start && out.length < 500; t += every * 60000) out.push(t);
    else out.push(nag);
  }
  out.push(start);
  return out;
}

// ---------- email ----------
function email_(kind, r) {
  const start = toMs_(r.start_at);
  const left = start - Date.now();
  const subjects = {
    reminder: '⏰ ' + r.title + ' in ' + until_(left),
    now: '🔔 Now: ' + r.title,
    ask: 'Did you do it? ' + r.title
  };
  const bodies = {
    reminder: '<p style="font-size:18px;margin:0 0 6px"><b>' + esc_(r.title) + '</b></p><p style="margin:0">' + when_(r.start_at) + ', in ' + until_(left) + '.</p>' + next_(r),
    now: '<p style="font-size:18px;margin:0 0 6px"><b>' + esc_(r.title) + '</b></p><p style="margin:0">It\'s time. This was set for ' + time_(r.start_at) + '.</p>',
    ask: '<p style="font-size:18px;margin:0 0 6px"><b>' + esc_(r.title) + '</b></p><p style="margin:0 0 12px">This was due ' + when_(r.start_at) + '. Mark it done, or mark it missed and say why.</p>'
  };
  const button = '<p style="margin:18px 0 0"><a href="' + SITE_URL + '" style="background:#1d6b57;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">' + (kind === 'ask' ? 'Answer in Goal Log' : 'Open Goal Log') + '</a></p>';
  MailApp.sendEmail({ to: to_(), subject: subjects[kind], htmlBody: wrap_(bodies[kind] + button) });
}
function next_(r) {
  const n = slots_(r).find(t => t > Date.now() + 60000);
  if (!n || n === toMs_(r.start_at)) return '';
  return '<p style="margin:8px 0 0;color:#5b6862">Next reminder ' + time_(iso_(n)) + '.</p>';
}
function wrap_(inner) {
  return '<div style="font-family:Arial,sans-serif;font-size:15px;color:#15201b;max-width:520px">' + inner +
    '<p style="margin:24px 0 0;color:#5b6862;font-size:12px">Sent by your Goal Log.</p></div>';
}

// ---------- sheet ----------
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME, 0);
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), COLS.length).setNumberFormat('@');
  }
  return sh;
}
function readAll_() {
  const sh = sheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, COLS.length).getValues().map((v, i) => ({
    _row: i + 2, title: String(v[1]), level: String(v[2]), status: String(v[3]), reason: String(v[4]),
    every: Number(v[6]) || 0, id: String(v[7]), start_at: String(v[8]), nag_at: String(v[9]),
    last_emailed: String(v[10]), asked: String(v[11]), created: String(v[12]), updated: String(v[13])
  })).filter(r => r.id);
}
function toRow_(r) {
  return [when_(r.start_at), r.title, r.level, r.status, r.reason, r.nag_at ? when_(r.nag_at) : '', r.every,
    r.id, r.start_at, r.nag_at || '', r.last_emailed || '', r.asked || '', r.created, r.updated];
}
function save_(r) {
  const sh = sheet_();
  if (r._row) sh.getRange(r._row, 1, 1, COLS.length).setValues([toRow_(r)]);
  else { sh.appendRow(toRow_(r)); r._row = sh.getLastRow(); }
}
function public_(r) {
  return { id: r.id, title: r.title, start_at: r.start_at, nag_at: r.nag_at || null, every: r.every,
    level: r.level, status: r.status, reason: r.reason };
}

// ---------- helpers ----------
function signedIn_(b) {
  if (PASSCODE === 'change-me') throw err_('Set a passcode in Code.gs first.', 'auth');
  if (!b || b.passcode !== PASSCODE) throw err_('Wrong passcode.', 'auth');
}
function to_() { return EMAIL || Session.getEffectiveUser().getEmail(); }
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function err_(message, code) { const e = new Error(message); e.code = code || null; return e; }
function clean_(t) { return String(t || '').trim(); }
function cut_(t, n) { return clean_(t).slice(0, n); }
function iso_(ms) { return new Date(ms).toISOString(); }
function toMs_(v) { if (!v) return 0; const ms = v instanceof Date ? v.getTime() : Date.parse(String(v)); return isNaN(ms) ? 0 : ms; }
function esc_(t) { return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function time_(iso) { return Utilities.formatDate(new Date(toMs_(iso)), Session.getScriptTimeZone(), 'h:mm a'); }
function when_(iso) { return Utilities.formatDate(new Date(toMs_(iso)), Session.getScriptTimeZone(), 'EEE, MMM d \'at\' h:mm a'); }
function until_(ms) {
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return h + ' hr' + (r ? ' ' + r + ' min' : '');
  const d = Math.floor(h / 24);
  return d + ' day' + (d > 1 ? 's' : '') + (h % 24 ? ' ' + (h % 24) + ' hr' : '');
}
