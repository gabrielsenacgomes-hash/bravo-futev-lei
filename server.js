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
const studentLoginAttempts = new Map();

if (PASSWORD.length < 12) {
  console.error('Defina ADMIN_PASSWORD com pelo menos 12 caracteres antes de iniciar.');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

function readData() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { students: value.students || [], slots: value.slots || [], bookings: value.bookings || [], studentAccounts: value.studentAccounts || [] };
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

    if (req.method === 'POST' && route === '/api/student/register') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(studentLoginAttempts, ip)) return json(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
      const body = await readBody(req), name = String(body.name || '').trim(), email = normalizeEmail(body.email), phone = phoneDigits(body.phone);
      const password = String(body.password || '');
      if (name.length < 2 || name.length > 120 || !validEmail(email) || phone.length < 10 || phone.length > 15 || password.length < 10 || password.length > 200) {
        return json(res, 400, { error: 'Informe seu nome, e-mail, WhatsApp e uma senha com pelo menos 10 caracteres.' });
      }
      const data = readData();
      data.studentAccounts = Array.isArray(data.studentAccounts) ? data.studentAccounts : [];
      const emailStudent = data.students.find(item => normalizeEmail(item.email) === email);
      const phoneStudent = data.students.find(item => phoneDigits(item.phone) === phone);
      if (emailStudent && phoneStudent && emailStudent.id !== phoneStudent.id) {
        return json(res, 409, { error: 'Este e-mail e este WhatsApp aparecem em cadastros diferentes. Fale com a equipe da Bravo para corrigir seus dados.' });
      }
      if ((emailStudent && phoneDigits(emailStudent.phone) !== phone) || (phoneStudent && normalizeEmail(phoneStudent.email) !== email)) {
        return json(res, 409, { error: 'Já existe um cadastro com parte desses dados. Confira seu e-mail e WhatsApp ou fale com a equipe da Bravo.' });
      }
      let student = emailStudent || phoneStudent;
      if (student && data.studentAccounts.some(account => account.studentId === student.id)) {
        return json(res, 409, { error: 'Esta conta já foi criada. Entre com seu e-mail e senha.' });
      }
      if (!student) {
        student = { id: crypto.randomUUID(), name, phone: String(body.phone || '').trim(), email,
          plan: 'Aguardando ativação', fee: '', schedule: '', expiresAt: '', status: 'Inativo',
          notes: 'Conta criada pelo aluno; aguardando definição e ativação do plano.' };
        data.students.unshift(student);
      }
      const account = { studentId: student.id, passwordHash: await hashPassword(password) };
      data.studentAccounts.push(account);
      saveData(data);
      studentLoginAttempts.delete(ip);
      return json(res, 201, { authenticated: true, student: studentSummary(student) }, setSession(res, req, 'student', student.id));
    }

    if (req.method === 'POST' && route === '/api/student/login') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(studentLoginAttempts, ip)) return json(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
      const body = await readBody(req), email = normalizeEmail(body.email), password = String(body.password || '');
      const data = readData();
      const student = data.students.find(item => normalizeEmail(item.email) === email);
      const account = student && data.studentAccounts.find(item => item.studentId === student.id);
      if (!student || !account || !await verifyPassword(password, account.passwordHash)) {
        return json(res, 401, { error: 'E-mail ou senha incorretos.' });
      }
      studentLoginAttempts.delete(ip);
      return json(res, 200, { authenticated: true, student: studentSummary(student) }, setSession(res, req, 'student', student.id));
    }

    if (req.method === 'POST' && route === '/api/student/logout') {
      const session = getSession(req); if (session?.role === 'student') sessions.delete(session.token);
      return json(res, 200, { authenticated: false }, { 'Set-Cookie': 'bravo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }

    if (req.method === 'GET' && route === '/api/student/session') {
      const session = requireStudent(req, res); if (!session) return;
      const data = readData(), student = data.students.find(item => item.id === session.studentId);
      if (!student) return json(res, 401, { error: 'Cadastro não encontrado. Fale com a equipe da Bravo.' });
      return json(res, 200, { authenticated: true, student: studentSummary(student) });
    }

    if (req.method === 'POST' && route === '/api/student/photo') {
      const session = requireStudent(req, res); if (!session) return;
      const body = await readBody(req), photoDataUrl = String(body.photoDataUrl || '');
      if (photoDataUrl) {
        const match = photoDataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
        if (!match) return json(res, 400, { error: 'Envie uma foto JPG válida.' });
        const bytes = Buffer.from(match[1], 'base64');
        if (bytes.length < 100 || bytes.length > 150000 || bytes.toString('base64') !== match[1] || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
          return json(res, 400, { error: 'A foto precisa ser JPG e ter até 150 KB depois da redução.' });
      }
      const data = readData(), student = data.students.find(item => item.id === session.studentId);
      if (!student) return json(res, 401, { error: 'Cadastro não encontrado.' });
      student.photoDataUrl = photoDataUrl; saveData(data);
      return json(res, 200, { student: studentSummary(student) });
    }

    if (req.method === 'GET' && route === '/api/student/bookings') {
      const session = requireStudent(req, res); if (!session) return;
      const data = readData(), student = data.students.find(item => item.id === session.studentId);
      if (!student) return json(res, 401, { error: 'Cadastro não encontrado.' });
      const bookings = data.bookings.filter(item => item.studentId === student.id || phoneDigits(item.phone) === phoneDigits(student.phone))
        .filter(item => item.date >= todayInBrazil()).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
      return json(res, 200, { bookings });
    }

    if (req.method === 'GET' && route === '/api/student/slots') {
      const session = requireStudent(req, res); if (!session) return;
      const date = url.searchParams.get('date');
      if (!dateIsValid(date) || date < todayInBrazil()) return json(res, 400, { error: 'Escolha uma data válida.' });
      const data = readData(), student = data.students.find(item => item.id === session.studentId);
      if (!student) return json(res, 401, { error: 'Cadastro não encontrado.' });
      const day = new Date(date + 'T12:00:00Z').getUTCDay();
      const available = data.slots.filter(slot => slot.open && Number(slot.day) === day).map(slot => {
        const matches = data.bookings.filter(b => b.date === date && b.slotId === slot.id);
        const participants = matches.map(booking => {
          const bookedStudent = data.students.find(item => item.id === booking.studentId || phoneDigits(item.phone) === phoneDigits(booking.phone));
          return { name: bookedStudent?.name || booking.name || 'Aluno', photoDataUrl: bookedStudent?.photoDataUrl || '' };
        });
        return { id: slot.id, day: Number(slot.day), start: slot.start, end: slot.end, capacity: Number(slot.capacity),
          remaining: Math.max(0, Number(slot.capacity) - matches.length), participants };
      }).sort((a, b) => a.start.localeCompare(b.start));
      return json(res, 200, { slots: available });
    }

    if (req.method === 'POST' && route === '/api/student/bookings') {
      const session = requireStudent(req, res); if (!session) return;
      const body = await readBody(req), date = String(body.date || '');
      if (!dateIsValid(date) || date < todayInBrazil()) return json(res, 400, { error: 'Escolha uma data válida.' });
      const data = readData(), student = data.students.find(item => item.id === session.studentId);
      if (!student) return json(res, 401, { error: 'Cadastro não encontrado.' });
      if (!isStudentActive(student)) return json(res, 403, { code: 'PLAN_INACTIVE', error: studentStatusMessage(student) });
      const slot = data.slots.find(item => item.id === body.slotId && item.open);
      if (!slot || Number(slot.day) !== new Date(date + 'T12:00:00Z').getUTCDay()) return json(res, 409, { error: 'Este horário não está mais aberto. Atualize a agenda.' });
      const sameSlot = data.bookings.filter(item => item.date === date && item.slotId === slot.id);
      if (sameSlot.length >= Number(slot.capacity)) return json(res, 409, { error: 'As vagas deste horário acabaram. Escolha outro.' });
      if (sameSlot.some(item => item.studentId === student.id || phoneDigits(item.phone) === phoneDigits(student.phone))) {
        return json(res, 409, { error: 'Você já reservou este horário.' });
      }
      const booking = { id: crypto.randomUUID(), studentId: student.id, slotId: slot.id, date,
        start: slot.start, end: slot.end, name: student.name, phone: student.phone };
      data.bookings.push(booking); saveData(data);
      return json(res, 201, { booking });
    }

    if (req.method === 'GET' && route === '/api/admin/state') {
      if (!requireAdmin(req, res)) return;
      const data = readData();
      return json(res, 200, { ...data, studentAccounts: data.students.map(student => ({ studentId: student.id,
        hasAccount: data.studentAccounts.some(account => account.studentId === student.id) })) });
    }
    if (req.method === 'PUT' && route === '/api/admin/state') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      const data = readData(), students = Array.isArray(body.students) ? body.students : [], slots = Array.isArray(body.slots) ? body.slots : [];
      if (slots.length > 500 || students.length > 20000) return json(res, 400, { error: 'Limite de cadastros excedido.' });
      if (students.some(student => student.expiresAt && !dateIsValid(student.expiresAt))) return json(res, 400, { error: 'Informe uma data de vencimento válida.' });
      const emails = students.map(student => normalizeEmail(student.email)).filter(Boolean);
      if (new Set(emails).size !== emails.length) return json(res, 400, { error: 'Cada aluno precisa ter um e-mail diferente para acessar a própria conta.' });
      if (slots.some(s => !Number.isInteger(Number(s.day)) || Number(s.day) < 0 || Number(s.day) > 6 || !/^\d{2}:\d{2}$/.test(s.start) || !/^\d{2}:\d{2}$/.test(s.end) || s.end <= s.start || !Number.isInteger(Number(s.capacity)) || Number(s.capacity) < 1 || Number(s.capacity) > 30)) return json(res, 400, { error: 'Revise os horários e o número de vagas.' });
      if (overlaps(slots)) return json(res, 400, { error: 'Há horários que se sobrepõem no mesmo dia.' });
      const studentIds = new Set(students.map(student => student.id));
      data.studentAccounts = data.studentAccounts.filter(account => studentIds.has(account.studentId));
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
