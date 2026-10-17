'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const sessions = new Map();
const loginAttempts = new Map();

if (PASSWORD.length < 12) {
  console.error('Defina ADMIN_PASSWORD com pelo menos 12 caracteres antes de iniciar.');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

function readData() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { students: value.students || [], slots: value.slots || [], bookings: value.bookings || [] };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Não foi possível ler data.json:', err.message);
    return { students: [], slots: [], bookings: [] };
  }
}
function saveData(data) {
  const temp = DATA_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}
function getSession(req) {
  const cookie = req.headers.cookie || '';
  const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('bravo_session='))?.slice('bravo_session='.length);
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) { if (token) sessions.delete(token); return null; }
  return token;
}
function requireAdmin(req, res) {
  if (getSession(req)) return true;
  json(res, 401, { error: 'Entre no painel da escola para continuar.' });
  return false;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) { reject(new Error('Requisição muito grande.')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}
function dateIsValid(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const d = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
}
function todayInBrazil() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function phoneDigits(value) { return String(value || '').replace(/\D/g, ''); }
function overlaps(slots) {
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
    const a = slots[i], b = slots[j];
    if (Number(a.day) === Number(b.day) && a.start < b.end && b.start < a.end) return true;
  }
  return false;
}
function constantTimeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  try {
    if (req.method === 'GET' && route === '/api/session') return json(res, 200, { authenticated: !!getSession(req) });

    if (req.method === 'POST' && route === '/api/login') {
      const ip = req.socket.remoteAddress || 'unknown';
      const attempt = loginAttempts.get(ip) || { count: 0, start: Date.now() };
      if (Date.now() - attempt.start > 10 * 60 * 1000) { attempt.count = 0; attempt.start = Date.now(); }
      if (attempt.count >= 8) return json(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
      const body = await readBody(req);
      if (!constantTimeEqual(body.password || '', PASSWORD)) {
        attempt.count++; loginAttempts.set(ip, attempt);
        return json(res, 401, { error: 'Senha incorreta.' });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return json(res, 200, { authenticated: true }, { 'Set-Cookie': `bravo_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}` });
    }

    if (req.method === 'POST' && route === '/api/logout') {
      const token = getSession(req); if (token) sessions.delete(token);
      return json(res, 200, { authenticated: false }, { 'Set-Cookie': 'bravo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }

    if (req.method === 'GET' && route === '/api/public/slots') {
      const date = url.searchParams.get('date');
      if (!dateIsValid(date)) return json(res, 400, { error: 'Informe uma data válida.' });
      const day = new Date(date + 'T12:00:00Z').getUTCDay();
      const data = readData();
      const available = data.slots.filter(slot => slot.open && Number(slot.day) === day).map(slot => {
        const used = data.bookings.filter(b => b.date === date && b.slotId === slot.id).length;
        return { ...slot, remaining: Math.max(0, Number(slot.capacity) - used) };
      }).filter(slot => slot.remaining > 0).sort((a, b) => a.start.localeCompare(b.start));
      return json(res, 200, { slots: available });
    }

    if (req.method === 'POST' && route === '/api/public/bookings') {
      const body = await readBody(req), date = String(body.date || ''), name = String(body.name || '').trim(), phone = String(body.phone || '').trim();
      if (!dateIsValid(date) || date < todayInBrazil()) return json(res, 400, { error: 'Escolha uma data válida.' });
      if (!name || name.length > 120 || phoneDigits(phone).length < 10 || phone.length > 40) return json(res, 400, { error: 'Confira seu nome e WhatsApp.' });
      const data = readData(), slot = data.slots.find(s => s.id === body.slotId && s.open);
      if (!slot || Number(slot.day) !== new Date(date + 'T12:00:00Z').getUTCDay()) return json(res, 409, { error: 'Este horário não está mais disponível. Atualize a agenda.' });
      const sameSlot = data.bookings.filter(b => b.date === date && b.slotId === slot.id);
      if (sameSlot.length >= Number(slot.capacity)) return json(res, 409, { error: 'As vagas deste horário acabaram. Escolha outro.' });
      if (sameSlot.some(b => phoneDigits(b.phone) === phoneDigits(phone))) return json(res, 409, { error: 'Você já reservou este horário.' });
      const booking = { id: crypto.randomUUID(), slotId: slot.id, date, start: slot.start, end: slot.end, name, phone };
      data.bookings.push(booking);
      if (!data.students.some(s => phoneDigits(s.phone) === phoneDigits(phone))) data.students.unshift({ id: crypto.randomUUID(), name, phone, email: '', plan: 'Aula experimental', fee: '', schedule: `${['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'][slot.day]} · ${slot.start}`, status: 'Experimental', notes: 'Cadastro criado pelo agendamento online' });
      saveData(data);
      return json(res, 201, { booking });
    }

    if (req.method === 'GET' && route === '/api/admin/state') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, readData());
    }
    if (req.method === 'PUT' && route === '/api/admin/state') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      const data = readData(), students = Array.isArray(body.students) ? body.students : [], slots = Array.isArray(body.slots) ? body.slots : [];
      if (slots.length > 500 || students.length > 20000) return json(res, 400, { error: 'Limite de cadastros excedido.' });
      if (slots.some(s => !Number.isInteger(Number(s.day)) || Number(s.day) < 0 || Number(s.day) > 6 || !/^\d{2}:\d{2}$/.test(s.start) || !/^\d{2}:\d{2}$/.test(s.end) || s.end <= s.start || !Number.isInteger(Number(s.capacity)) || Number(s.capacity) < 1 || Number(s.capacity) > 30)) return json(res, 400, { error: 'Revise os horários e o número de vagas.' });
      if (overlaps(slots)) return json(res, 400, { error: 'Há horários que se sobrepõem no mesmo dia.' });
      saveData({ ...data, students, slots });
      return json(res, 200, { saved: true });
    }
    if (req.method === 'DELETE' && route.startsWith('/api/admin/bookings/')) {
      if (!requireAdmin(req, res)) return;
      const id = decodeURIComponent(route.slice('/api/admin/bookings/'.length)), data = readData();
      const before = data.bookings.length; data.bookings = data.bookings.filter(b => b.id !== id);
      if (before === data.bookings.length) return json(res, 404, { error: 'Reserva não encontrada.' });
      saveData(data); return json(res, 200, { cancelled: true });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 404, { error: 'Rota não encontrada.' });
    const requested = route === '/' ? 'index.html' : decodeURIComponent(route.replace(/^\/+/, ''));
    const file = path.resolve(PUBLIC_DIR, requested);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Página não encontrada.' });
    const extension = path.extname(file);
    const type = extension === '.html' ? 'text/html; charset=utf-8' : extension === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Erro interno. Tente novamente.' });
    else res.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Bravo Futevôlei rodando na porta ${PORT}.`));
