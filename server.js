/* ============================================================
   PSYCHE-delic — companion server
   ------------------------------------------------------------
   • Serves the static site (index.html, admin.html, …)
   • Saves exercise responses for the admin review page
   • Emails recorded readings using email-config.json

   Run:  node server.js
   Then open:  http://localhost:3001/index.html
   ============================================================ */
const express = require('express');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const EMAIL_CONFIG_FILE = path.join(__dirname, 'email-config.json');

/* Tiny .env loader (no dependency) — loads key=value pairs, without
   overwriting variables that are already set in the environment. */
function loadEnv(file){
  try {
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const line of lines){
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch(e){ /* ignore */ }
}
loadEnv(path.join(__dirname, '.env'));

/* Admin key must be set (in .env locally, or in the host's environment settings). */
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY || ADMIN_KEY === 'psyche-admin' || ADMIN_KEY.length < 12) {
  console.error('ADMIN_KEY is missing or too weak. Set ADMIN_KEY to a long random value (12+ characters).');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));
/* Serve ONLY the two public pages — never the whole folder, which would
   expose data.json, .env, email-config.json and server.js. */
const sendPage = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.get('/', sendPage('index.html'));
app.get('/index.html', sendPage('index.html'));
app.get('/admin.html', sendPage('admin.html'));

/* ============================================================
   Tiny JSON-file store (users, tokens, responses)
   ============================================================ */
let db = { users: [], tokens: [], responses: [] };
function loadDb(){
  try {
    if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e){ console.error('Could not read data.json:', e.message); }
}
function saveDb(){
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  catch(e){ console.error('Could not write data.json:', e.message); }
}
loadDb();

/* ---------- helpers ---------- */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
function publicUser(u){ return { id: u.id, name: u.name, email: u.email, active: u.active !== false }; }
function findUserByToken(token){
  if(!token) return null;
  const t = db.tokens.find(x => x.token === token);
  return t ? db.users.find(u => u.id === t.userId) || null : null;
}
function escapeHtml(s){
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================
   Email config (email-config.json) — "my configured settings"
   ============================================================ */
function loadEmailConfig(){
  try { return JSON.parse(fs.readFileSync(EMAIL_CONFIG_FILE, 'utf8')); }
  catch(e){ return null; }
}
// Relay service config (e.g. FormSubmit) — no password needed.
function relayFromConfig(){
  const cfg = loadEmailConfig();
  if(!cfg || !cfg.relay) return null;
  const to = process.env.RELAY_TO || cfg.relay.to || null;
  if(!to) return null;
  return { provider: cfg.relay.provider || 'formsubmit', to };
}
// SMTP config (only used when no relay is configured).
function smtpFromConfig(){
  const cfg = loadEmailConfig();
  if(!cfg) return null;
  const profile = cfg.outlook || cfg.smtp || null;
  if(!profile) return null;
  const auth = profile.auth || {};
  // Secrets come from the environment / .env first, so your app password
  // never has to live in email-config.json.
  const user = process.env.SMTP_USER || auth.user || null;
  const pass = process.env.SMTP_PASS || auth.pass || '';
  const to = process.env.SMTP_TO || profile.to || user;
  return Object.assign({}, profile, { auth: { user, pass }, to });
}
// Tiny JSON POST helper (no dependency) for calling the relay service.
function postJSON(url, data, extraHeaders){
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch(e){ return reject(e); }
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }, extraHeaders || {})
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch(e){}
        resolve({ status: res.statusCode, data: parsed, raw });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ============================================================
   deliverReadingEmail — send a recorded reading to the address
   configured in email-config.json (relay first, SMTP fallback).
   Options: { tileId, tileTitle, payload, user?, to? }
   Resolves to { ok:boolean, error?:string } — never throws.
   ============================================================ */
async function deliverReadingEmail({ tileId, tileTitle, payload, user, to }){
  function fmt(v){
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch(e){ return String(v); }
  }

  const date = new Date().toLocaleString();
  const submittedBy = user && user.email
    ? 'Recorded by ' + (user.name || '') + ' <' + user.email + '>'
    : 'Recorded by an anonymous visitor';
  const subject = '[Psyche-delic] Recorded reading — ' + tileTitle;

  /* ----- Relay path (default; no password needed) ----- */
  const relay = relayFromConfig();
  if (relay){
    const fields = {
      name: 'Psyche-delic',
      _subject: subject,
      _template: 'table',
      _captcha: 'false',
      _from: submittedBy,
      _date: date
    };
    Object.keys(payload || {}).forEach(k => { fields[k] = fmt(payload[k]); });
    try {
      const r = await postJSON('https://formsubmit.co/ajax/' + encodeURIComponent(relay.to), fields, {
        Origin: 'http://localhost:' + PORT,
        Referer: 'http://localhost:' + PORT + '/index.html'
      });
      const ok = r.data && (r.data.success === 'true' || r.data.success === true);
      if (ok) return { ok:true };
      const msg = (r.data && r.data.message) || ('Relay returned HTTP ' + r.status);
      console.error('Relay send failed:', msg);
      return { ok:false, error: msg };
    } catch (err) {
      console.error('Relay send failed:', err.message);
      return { ok:false, error: err.message };
    }
  }

  /* ----- SMTP fallback (only if relay is not configured) ----- */
  const smtp = smtpFromConfig();
  if (!smtp || !smtp.host || !smtp.auth || !smtp.auth.user) {
    return { ok:false, error:'No email delivery configured — add a "relay" block to email-config.json' };
  }
  const { host, port = 587, secure = false, auth = {} } = smtp;
  const fromAddr = auth.user;
  const toAddr = to || smtp.to || fromAddr;
  if (!fromAddr) return { ok:false, error:'Missing auth.user in email-config.json' };

  const rows = Object.keys(payload || {}).map(k =>
    '<tr>'+
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;vertical-align:top;font-family:monospace;font-size:12px;color:#8a4a63;white-space:nowrap;">'+escapeHtml(k)+'</td>'+
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;vertical-align:top;font-family:Georgia,serif;font-size:14px;color:#021e21;">'+escapeHtml(fmt(payload[k])).replace(/\n/g,'<br>')+'</td>'+
    '</tr>'
  ).join('');
  const html =
    '<div style="font-family:Georgia,serif;color:#021e21;max-width:640px;margin:0 auto;">'+
      '<div style="border-bottom:2px solid #be6885;padding-bottom:14px;margin-bottom:18px;">'+
        '<div style="font-family:monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5c7f83;">Psyche-delic — a field guide to your own mind</div>'+
        '<h1 style="margin:6px 0 2px;font-size:22px;color:#021e21;">Recorded reading</h1>'+
        '<div style="color:#5c7f83;font-size:13px;">'+escapeHtml(tileTitle)+(tileId ? ' &nbsp;·&nbsp; '+escapeHtml(String(tileId)) : '')+' &nbsp;·&nbsp; '+date+'</div>'+
      '</div>'+
      '<table style="border-collapse:collapse;width:100%;border:1px solid #eee;">'+rows+'</table>'+
      '<p style="color:#5c7f83;font-size:12px;line-height:1.6;">'+submittedBy+'</p>'+
      '<p style="color:#5c7f83;font-size:12px;line-height:1.6;border-top:1px dashed #ddd;padding-top:12px;">This is a personal reflection recorded on Psyche-delic. It is not a diagnosis and should not be treated as one.</p>'+
    '</div>';

  try {
    const transporter = nodemailer.createTransport({ host, port, secure, auth });
    await transporter.sendMail({
      from: '"Psyche-delic" <' + fromAddr + '>',
      to: toAddr,
      subject,
      html
    });
    return { ok:true };
  } catch (err) {
    console.error('Email send failed:', err.message);
    return { ok:false, error: err.message };
  }
}

/* ============================================================
   POST /api/email — email a recorded reading (direct endpoint;
   the response flow below also calls deliverReadingEmail).
   Body: { tileId, tileTitle, payload, user?, to? }
   ============================================================ */
app.post('/api/email', async (req, res) => {
  const body = req.body || {};
  if (!body.tileTitle) return res.status(400).json({ ok:false, error:'tileTitle is required' });
  const result = await deliverReadingEmail({
    tileId: body.tileId,
    tileTitle: body.tileTitle,
    payload: body.payload,
    user: body.user,
    to: body.to
  });
  if (result.ok) return res.json({ ok:true });
  return res.status(502).json({ ok:false, error: result.error });
});

/* ============================================================
   POST /api/submit — the test form: name + email, plus one or
   more recorded tests. Saves each reading and sends ONE email.
   Body: { name, email, readings:[{ tileId, tileTitle, payload }] }
   ============================================================ */
app.post('/api/submit', async (req, res) => {
  const { name, email, readings } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 200);
  const cleanEmail = String(email || '').trim().slice(0, 200);
  if (!cleanName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error:'A name and a valid email are required' });
  }
  if (!Array.isArray(readings) || !readings.length || readings.length > 20) {
    return res.status(400).json({ error:'Record at least one test before submitting' });
  }
  const valid = readings.filter(r => r && r.tileId && r.tileTitle);
  if (!valid.length) return res.status(400).json({ error:'No valid tests in this submission' });

  const submitter = { name: cleanName, email: cleanEmail };
  const submittedAt = new Date().toISOString();
  valid.forEach(r => {
    db.responses.push({
      id: db.responses.length + 1,
      userId: null,
      submitter,
      tileId: String(r.tileId),
      tileTitle: String(r.tileTitle),
      payload: r.payload || {},
      submittedAt
    });
  });
  saveDb();

  // One email: who submitted, then one row per test with its answers.
  const asText = (p) => Object.keys(p || {}).map(k => {
    const v = p[k];
    return k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v));
  }).join('\n');
  const payload = { 'Name': cleanName, 'Email': cleanEmail };
  valid.forEach(r => { payload[String(r.tileTitle)] = asText(r.payload); });
  const mail = await deliverReadingEmail({
    tileId: null,
    tileTitle: cleanName + ' — ' + valid.length + ' test' + (valid.length > 1 ? 's' : ''),
    payload,
    user: submitter
  });
  res.json({ ok:true, saved: valid.length, emailOk: mail.ok, emailError: mail.error });
});

/* ============================================================
   Auth
   ============================================================ */
app.post('/api/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error:'Name, email and password are required' });
  if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error:'An account with this email already exists' });
  }
  // New accounts are activated automatically at registration — there is no
  // manual/admin approval step, so the user can record readings right away.
  const user = {
    id: db.users.length + 1,
    name, email, passwordHash: sha(password),
    active: true,
    activatedAt: new Date().toISOString()
  };
  db.users.push(user);
  const token = newToken();
  db.tokens.push({ token, userId: user.id });
  saveDb();
  res.json({ token, user: publicUser(user), activated: true });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find(u =>
    u.email.toLowerCase() === String(email || '').toLowerCase() &&
    u.passwordHash === sha(password || '')
  );
  if (!user || user.active === false) return res.status(401).json({ error:'Invalid email or password' });
  const token = newToken();
  db.tokens.push({ token, userId: user.id });
  saveDb();
  res.json({ token, user: publicUser(user) });
});

/* ============================================================
   Responses (user-facing save + admin review)
   ============================================================ */
app.post('/api/responses', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ error:'Authentication required' });
  const { tileId, tileTitle, payload } = req.body || {};
  if (!tileId || !tileTitle) return res.status(400).json({ error:'tileId and tileTitle are required' });
  const r = {
    id: db.responses.length + 1,
    userId: user.id,
    tileId,
    tileTitle,
    payload: payload || {},
    submittedAt: new Date().toISOString()
  };
  db.responses.push(r);
  saveDb();
  // Whenever a (registered, auto-activated) user records a response, email a
  // copy to the address configured in email-config.json — the owner of the
  // site receives every reading. The response is saved first so a delivery
  // problem never loses the reading itself.
  let emailOk = false;
  let emailError;
  try {
    const mail = await deliverReadingEmail({ tileId, tileTitle, payload: payload || {}, user: publicUser(user) });
    emailOk = mail.ok;
    emailError = mail.error;
  } catch (err) {
    console.error('Could not email response:', err.message);
    emailError = err.message || String(err);
  }
  res.json({ ok:true, id:r.id, emailOk, emailError });
});

app.get('/api/admin/responses', (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(401).json({ error:'Invalid admin key' });
  const { tileId } = req.query;
  let list = db.responses;
  if (tileId) list = list.filter(r => r.tileId === tileId);
  const out = list.map(r => {
    const u = db.users.find(x => x.id === r.userId);
    return Object.assign({}, r, { user: u ? publicUser(u) : (r.submitter || null) });
  });
  res.json({ responses: out });
});

/* ============================================================
   Start
   ============================================================ */
app.listen(PORT, () => {
  console.log('Psyche-delic server running at http://localhost:' + PORT);
  console.log('Static files served from: ' + __dirname);
  const relay = relayFromConfig();
  if (relay) console.log('Email delivery: relay (' + relay.provider + ') → ' + relay.to);
  else {
    const smtp = smtpFromConfig();
    if (!smtp || !smtp.host) console.warn('Warning: no email delivery configured in email-config.json');
    else console.log('Email delivery: SMTP → ' + (smtp.to || smtp.auth.user || '(unknown)'));
  }
});
