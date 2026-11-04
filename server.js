'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { reminderConfig, runReminders, verifyWhatsAppConnection } = require('./reminders');
const { createStorage, StorageError } = require('./storage');

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const sessions = new Map();
const loginAttempts = new Map();
const studentLoginAttempts = new Map();

if (PASSWORD.length < 12) {
  console.error('Defina ADMIN_PASSWORD com pelo menos 12 caracteres antes de iniciar.');
  process.exit(1);
}
const storage = createStorage();
const readData = () => storage.readData();
const saveData = data => storage.saveData(data);

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}
function getSession(req) {
  const cookie = req.headers.cookie || '';
  const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('bravo_session='))?.slice('bravo_session='.length);
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) { if (token) sessions.delete(token); return null; }
  return { ...session, token };
}
function requireAdmin(req, res) {
  const session = getSession(req);
  if (session?.role === 'admin') return session;
  json(res, 401, { error: 'Entre no painel da escola para continuar.' });
  return null;
}
function requireStudent(req, res) {
  const session = getSession(req);
  if (session?.role === 'student') return session;
  json(res, 401, { error: 'Entre na sua conta para continuar.' });
  return null;
}
function rateLimited(map, ip, max = 8) {
  const now = Date.now(), attempt = map.get(ip) || { count: 0, start: now };
  if (now - attempt.start > 10 * 60 * 1000) { attempt.count = 0; attempt.start = now; }
  if (attempt.count >= max) { map.set(ip, attempt); return true; }
  attempt.count++; map.set(ip, attempt); return false;
}
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254; }
function isStudentActive(student) {
  return student?.status === 'Ativo' && (!student.expiresAt || (dateIsValid(student.expiresAt) && student.expiresAt >= todayInBrazil()));
}
function studentStatusMessage(student) {
  if (student?.status === 'Inativo' && student?.plan === 'Aguardando ativação') return 'Sua conta foi criada. A equipe da Bravo precisa definir e ativar seu plano para liberar a marcação de treinos.';
  if (student?.expiresAt && dateIsValid(student.expiresAt) && student.expiresAt < todayInBrazil()) {
    const [year, month, day] = student.expiresAt.split('-');
    return `Seu plano venceu em ${day}/${month}/${year}. Fale com a equipe da Bravo para renovar e liberar novos treinos.`;
  }
  return 'Seu plano está inativo. Fale com a equipe da Bravo para regularizar antes de marcar novos treinos.';
}
function studentSummary(student) {
  const active = isStudentActive(student);
  return { id: student.id, name: student.name, email: student.email, plan: student.plan, status: student.status,
    expiresAt: student.expiresAt || '', photoDataUrl: student.photoDataUrl || '', active, message: active ? '' : studentStatusMessage(student) };
}
function setSession(res, req, role, studentId = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { expires: Date.now() + 12 * 60 * 60 * 1000, role, studentId });
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return { 'Set-Cookie': `bravo_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}` };
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(`${salt}:${key.toString('hex')}`)));
}
function verifyPassword(password, stored) {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex || !/^[a-f0-9]{128}$/i.test(hex)) return Promise.resolve(false);
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => {
    if (err) return reject(err);
    resolve(crypto.timingSafeEqual(key, Buffer.from(hex, 'hex')));
  }));
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
    if (req.method === 'GET' && route === '/api/session') return json(res, 200, { authenticated: getSession(req)?.role === 'admin' });

    if (req.method === 'POST' && route === '/api/login') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(loginAttempts, ip)) return json(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
      const body = await readBody(req);
      if (!constantTimeEqual(body.password || '', PASSWORD)) return json(res, 401, { error: 'Senha incorreta.' });
      loginAttempts.delete(ip);
      return json(res, 200, { authenticated: true }, setSession(res, req, 'admin'));
    }

    if (req.method === 'POST' && route === '/api/logout') {
      const session = getSession(req); if (session) sessions.delete(session.token);
      return json(res, 200, { authenticated: false }, { 'Set-Cookie': 'bravo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }

    if (route.startsWith('/api/student/')) return json(res, 404, { error: 'Acesso exclusivo da escola.' });

    if (req.method === 'GET' && route === '/api/admin/storage') {
      if (!requireAdmin(req, res)) return;
      await readData();
      return json(res, 200, { ...storage.info, connected: true });
    }

    if (req.method === 'POST' && route === '/api/admin/whatsapp/verify') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, await verifyWhatsAppConnection());
    }

    if (req.method === 'GET' && route === '/api/admin/reminders') {
      if (!requireAdmin(req, res)) return;
      const config = reminderConfig();
      return json(res, 200, { ...config, records: Object.values((await readData()).reminders) });
    }

    if (req.method === 'GET' && route === '/api/admin/state') {
      if (!requireAdmin(req, res)) return;
      const data = await readData();
      return json(res, 200, { ...data, dataVersion: storage.version(data), studentAccounts: data.students.map(student => ({ studentId: student.id,
        hasAccount: data.studentAccounts.some(account => account.studentId === student.id) })) });
    }
    if (req.method === 'PUT' && route === '/api/admin/state') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      if (!Array.isArray(body?.students)) return json(res, 400, { error: 'Informe a lista de alunos para salvar.' });
      const data = await readData();
      if (body.dataVersion !== undefined && body.dataVersion !== storage.version(data)) return json(res, 409, { error: 'Os cadastros foram atualizados em outra operação. Recarregue a página antes de salvar.' });
      const students = body.students, slots = Array.isArray(body.slots) ? body.slots : data.slots;
      if (slots.length > 500 || students.length > 20000) return json(res, 400, { error: 'Limite de cadastros excedido.' });
      if (students.some(student => student && student.expiresAt && !dateIsValid(student.expiresAt))) return json(res, 400, { error: 'Informe uma data de vencimento válida.' });
      if (students.some(student => {
        const unchanged = student && data.students.find(existing => existing.id === student.id && JSON.stringify(existing) === JSON.stringify(student));
        if (unchanged) return false;
        return !student || typeof student.id !== 'string' || !student.id || typeof student.name !== 'string' || student.name.trim().length < 2 || student.name.length > 120 || phoneDigits(student.phone).length < 10 || phoneDigits(student.phone).length > 15 || student.fee === '' || student.fee == null || !Number.isFinite(Number(student.fee)) || Number(student.fee) < 0 || !dateIsValid(student.expiresAt);
      })) return json(res, 400, { error: 'Informe nome, telefone, valor do plano e vencimento válidos.' });
      if (new Set(students.map(student => student.id)).size !== students.length) return json(res, 400, { error: 'Cadastros duplicados.' });
      if (slots.some(s => !Number.isInteger(Number(s.day)) || Number(s.day) < 0 || Number(s.day) > 6 || !/^\d{2}:\d{2}$/.test(s.start) || !/^\d{2}:\d{2}$/.test(s.end) || s.end <= s.start || !Number.isInteger(Number(s.capacity)) || Number(s.capacity) < 1 || Number(s.capacity) > 30)) return json(res, 400, { error: 'Revise os horários e o número de vagas.' });
      if (overlaps(slots)) return json(res, 400, { error: 'Há horários que se sobrepõem no mesmo dia.' });
      const studentIds = new Set(students.map(student => student.id));
      data.studentAccounts = data.studentAccounts.filter(account => studentIds.has(account.studentId));
      const updated = { ...data, students, slots };
      await saveData(updated);
      return json(res, 200, { saved: true, dataVersion: storage.version(updated) });
    }
    if (req.method === 'DELETE' && route.startsWith('/api/admin/bookings/')) {
      if (!requireAdmin(req, res)) return;
      const id = decodeURIComponent(route.slice('/api/admin/bookings/'.length)), data = await readData();
      const before = data.bookings.length; data.bookings = data.bookings.filter(b => b.id !== id);
      if (before === data.bookings.length) return json(res, 404, { error: 'Reserva não encontrada.' });
      await saveData(data); return json(res, 200, { cancelled: true });
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
    if (err instanceof StorageError) return json(res, err.statusCode, { error: err.message });
    console.error('Falha ao processar requisição.');
    if (!res.headersSent) json(res, 500, { error: 'Erro interno. Tente novamente.' });
    else res.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Bravo Futevôlei rodando na porta ${PORT}.`));

// Only one reminder sweep runs at a time; services must restart with the app.
let reminderRunning = false;
async function checkReminders() {
  if (reminderRunning) return;
  reminderRunning = true;
  try { await runReminders({ readData, saveData }); }
  catch { console.error('Não foi possível verificar os avisos de mensalidade. Revise a configuração do WhatsApp.'); }
  finally { reminderRunning = false; }
}
checkReminders();
setInterval(checkReminders, 60 * 60 * 1000).unref();
