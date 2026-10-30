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
const SITE_URL = 'https://yeayea240711.github.io/Goal-Log/';
const MORNING_HOUR = 7;      // the "today's plan" email, in the script's time zone. Set to -1 to turn it off.
const ASK_AFTER_MIN = 60;    // this long after a task's time, you get a "did you do it?" email
const WORKOUT_HOURS = [17, 19, 21];  // on a workout day with no finished workout, you get an email at these hours

const SHEET_NAME = 'Tasks';
const COLS = ['When', 'Task', 'Level', 'Status', 'Why missed', 'Remind from', 'Every (min)',
  'id', 'start_at', 'nag_at', 'last_emailed', 'asked', 'Created', 'Updated'];
const LEVELS = ['light', 'normal', 'cantmiss'];
const LIFT_SHEET = 'Lift';   // the workout log: one row per workout, diet day, or your settings
const LIFT_COLS = ['id', 'kind', 'day', 'json', 'updated'];
const MAX_DOC = 45000;       // a Sheet cell holds 50,000 characters

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

  // ---------- workouts (the Workouts page) ----------
  lift_list: () => liftAll_().filter(d => d.kind !== 'miss').map(d => ({ id: d.id, data: d.data })),

  lift_put: b => { liftPut_(b.id, b.data); return { ok: true }; },

  lift_del: b => {
    const d = liftAll_().find(x => x.id === b.id);
    if (d) liftSheet_().deleteRow(d._row);
    return { ok: true };
  },

  lift_import: b => {
    const docs = Array.isArray(b.docs) ? b.docs : [];
    if (docs.length > 2000) throw err_('That file is too big to import at once.');
    const rows = liftAll_();
    docs.forEach(d => liftPut_(d.id, d.data, rows));
    return { count: docs.length };
  },

  // workout days you skipped in the last week, for the "Did you do these?" list
  workout_misses: () => workoutMisses_(7),

  workout_reason: b => {
    const day = String(b.day || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw err_('Unknown day.');
    liftPut_('m-' + day, { kind: 'miss', day, reason: cut_(b.reason, 500) });
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
  liftSheet_();
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
    workoutReminder_();
  });
}

// On a workout day, nag at WORKOUT_HOURS until a workout is finished.
function workoutReminder_() {
  const tz = Session.getScriptTimeZone(), now = new Date();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const hour = Number(Utilities.formatDate(now, tz, 'H'));
  const slot = WORKOUT_HOURS.filter(h => h <= hour).pop();
  if (slot === undefined) return;
  const key = today + ' ' + slot, props = PropertiesService.getScriptProperties();
  if (props.getProperty('workout_emailed') === key) return;
  const w = workoutState_();
  if (!w.isPlanDay(today) || w.doneDays[today]) return;
  props.setProperty('workout_emailed', key);
  const last = slot === WORKOUT_HOURS[WORKOUT_HOURS.length - 1];
  const site = SITE_URL + 'workouts.html';
  MailApp.sendEmail({ to: to_(), subject: (last ? '🔔 Last call: ' : '🏋️ ') + 'Workout day',
    htmlBody: wrap_('<p style="font-size:18px;margin:0 0 6px"><b>Today is a workout day.</b></p><p style="margin:0">You haven\'t finished a workout yet.' +
      (last ? ' This is the last reminder today.' : '') + '</p>' +
      '<p style="margin:18px 0 0"><a href="' + site + '" style="background:#1d6b57;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open Workouts</a></p>') });
}

// Each morning: today's tasks and anything still waiting for an answer.
function morningPlan() {
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const all = readAll_();
  const todays = all.filter(r => r.status === 'open' && Utilities.formatDate(new Date(toMs_(r.start_at)), tz, 'yyyy-MM-dd') === today)
    .sort((a, b) => toMs_(a.start_at) - toMs_(b.start_at));
  const waiting = all.filter(r => r.status === 'open' && toMs_(r.start_at) < Date.now() - ASK_AFTER_MIN * 60000);
  const w = workoutState_();
  const workoutToday = w.isPlanDay(today) && !w.doneDays[today];
  const skipped = workoutMisses_(7).filter(m => !m.reason);
  if (!todays.length && !waiting.length && !workoutToday && !skipped.length) return;
  let html = '';
  if (workoutToday) html += '<p style="font-size:16px;margin:0 0 12px">🏋️ <b>Workout day today.</b></p>';
  if (todays.length) html += '<h3 style="margin:0 0 8px">Today</h3><ul>' + todays.map(r => '<li><b>' + time_(r.start_at) + '</b> ' + esc_(r.title) + (r.level === 'cantmiss' ? ' <span style="color:#b13a2d">(can\'t miss)</span>' : '') + '</li>').join('') + '</ul>';
  if (waiting.length) html += '<h3 style="margin:16px 0 8px">Still waiting on an answer</h3><ul>' + waiting.map(r => '<li>' + esc_(r.title) + ' (' + when_(r.start_at) + ')</li>').join('') + '</ul>';
  if (skipped.length) html += '<h3 style="margin:16px 0 8px">Workouts you skipped</h3><ul>' + skipped.map(m => '<li>' + dayName_(m.day) + '</li>').join('') + '</ul><p style="margin:0">Say why in Goal Log.</p>';
  MailApp.sendEmail({ to: to_(), subject: 'Today: ' + (todays.length ? todays.length + ' task' + (todays.length > 1 ? 's' : '') : workoutToday ? 'workout day' : 'nothing scheduled') + (todays.length && workoutToday ? ' + workout' : ''), htmlBody: wrap_(html) });
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

// ---------- workout sheet ----------
function liftSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(LIFT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LIFT_SHEET);
    sh.getRange(1, 1, 1, LIFT_COLS.length).setValues([LIFT_COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), LIFT_COLS.length).setNumberFormat('@');
  }
  return sh;
}
function liftAll_() {
  const sh = liftSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, LIFT_COLS.length).getValues().map((v, i) => {
    let data = null;
    try { data = JSON.parse(String(v[3])); } catch (e) {}
    return { _row: i + 2, id: String(v[0]), kind: String(v[1]), day: String(v[2]), data };
  }).filter(d => d.id && d.data);
}
// Save one doc. Pass `rows` when saving many at once so the sheet is read only once.
function liftPut_(id, data, rows) {
  id = String(id || '');
  if (!/^[\w-]{1,80}$/.test(id)) throw err_('Bad item name.');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw err_('Bad item.');
  const json = JSON.stringify(data);
  if (json.length > MAX_DOC) throw err_('That entry is too big to save.');
  const kind = id === 'profile' ? 'profile' : String(data.kind || '');
  let day = '';
  if (kind === 'workout' && data.startedAt) day = Utilities.formatDate(new Date(toMs_(data.startedAt)), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  else if (kind === 'diet' || kind === 'miss') day = String(data.day || '');
  const row = [id, kind, day, json, iso_(Date.now())];
  const sh = liftSheet_();
  const list = rows || liftAll_();
  const found = list.find(d => d.id === id);
  if (found) sh.getRange(found._row, 1, 1, LIFT_COLS.length).setValues([row]);
  else { sh.appendRow(row); if (rows) rows.push({ _row: sh.getLastRow(), id, kind, day, data }); }
}
// Which weekdays are workout days, and which days have a finished workout.
function workoutState_() {
  const all = liftAll_();
  const prof = (all.find(d => d.id === 'profile') || {}).data || {};
  const plan = Array.isArray(prof.plan) ? prof.plan.map(Number) : [];
  const since = String(prof.planSince || '');
  const doneDays = {}, reasons = {};
  all.forEach(d => {
    if (d.kind === 'workout' && d.data.finishedAt && d.day) doneDays[d.day] = true;
    if (d.kind === 'miss') reasons[d.day] = d.data.reason || '';
  });
  const isPlanDay = day => !!since && day >= since && plan.indexOf(dow_(day)) >= 0;
  return { plan, since, doneDays, reasons, isPlanDay };
}
// Workout days in the last `n` days (not today) with no finished workout.
function workoutMisses_(n) {
  const w = workoutState_(), out = [], tz = Session.getScriptTimeZone();
  const p = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd').split('-').map(Number);
  for (let i = n; i >= 1; i--) {
    const day = Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2] - i, 12)), 'UTC', 'yyyy-MM-dd');
    if (w.isPlanDay(day) && !w.doneDays[day]) out.push({ day, reason: w.reasons[day] || '' });
  }
  return out;
}
// 0 = Sunday, matching the Workouts page
function dow_(day) { const p = day.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); }
function dayName_(day) { const p = day.split('-').map(Number); return Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)), 'UTC', 'EEEE, MMM d'); }

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
