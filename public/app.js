'use strict';

const REMOTE = /^https?:$/.test(location.protocol);
const STORAGE = { students: 'areia-alunos-v1', slots: 'bravo-horarios-v1', bookings: 'bravo-reservas-v1' };
const $ = id => document.getElementById(id);
const dayNames = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const money = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(Number(n) || 0);
const digits = value => String(value || '').replace(/\D/g, '');
const esc = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let students = [], slots = [], bookings = [], remoteAvailability = [], selectedSlotId = '';
let adminAuthenticated = !REMOTE, studentAuthenticated = !REMOTE;
let studentProfile = null, studentBookings = [], studentAccounts = [];
let saveQueue = Promise.resolve();
try {
  students = JSON.parse(localStorage.getItem(STORAGE.students) || '[]');
  slots = JSON.parse(localStorage.getItem(STORAGE.slots) || '[]');
  bookings = JSON.parse(localStorage.getItem(STORAGE.bookings) || '[]');
} catch { /* Start with empty records if local browser storage is unreadable. */ }

function isoToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2400);
}
function cacheLocally() {
  localStorage.setItem(STORAGE.students, JSON.stringify(students));
  localStorage.setItem(STORAGE.slots, JSON.stringify(slots));
  localStorage.setItem(STORAGE.bookings, JSON.stringify(bookings));
}
function persist() {
  cacheLocally();
  render();
  if (REMOTE && adminAuthenticated) {
    saveQueue = saveQueue.then(async () => {
      const response = await fetch('/api/admin/state', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ students, slots })
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'Não foi possível salvar as alterações.');
      }
    }).catch(error => showToast(error.message));
  }
}
async function loadAdminState() {
  const response = await fetch('/api/admin/state');
  if (response.status === 401) { adminAuthenticated = false; return false; }
  if (!response.ok) throw new Error('Não foi possível carregar os dados da escola.');
  const data = await response.json();
  students = data.students || [];
  slots = data.slots || [];
  bookings = data.bookings || [];
  studentAccounts = data.studentAccounts || [];
  adminAuthenticated = true;
  cacheLocally();
  render();
  return true;
}
async function loadPublicAvailability() {
  const date = $('bookingDate').value;
  if (!date) return;
  if (!REMOTE) { renderAvailable(); return; }
  if (!studentAuthenticated || !studentProfile?.active) { remoteAvailability = []; renderAvailable(); return; }
  try {
    const response = await fetch('/api/student/slots?date=' + encodeURIComponent(date));
    const data = await response.json();
    if (response.status === 401) { studentAuthenticated = false; switchMode('student'); return; }
    if (response.status === 403) {
      studentProfile.active = false; studentProfile.message = data.error || 'Seu plano está inativo.';
      applyStudentStatus(); remoteAvailability = []; renderAvailable(); return;
    }
    if (!response.ok) throw new Error(data.error || 'Não foi possível carregar a agenda.');
    remoteAvailability = data.slots || [];
    if (!remoteAvailability.some(slot => slot.id === selectedSlotId)) selectedSlotId = '';
    renderAvailable();
  } catch {
    remoteAvailability = []; renderAvailable(); showToast('Não foi possível carregar a agenda agora.');
  }
}
async function loadStudentBookings() {
  if (!REMOTE || !studentAuthenticated) return;
  const response = await fetch('/api/student/bookings');
  if (response.status === 401) { studentAuthenticated = false; switchMode('student'); return; }
  const data = await response.json(); studentBookings = data.bookings || []; renderMyBookings();
}
function applyStudentStatus() {
  const active = !REMOTE || !!studentProfile?.active;
  $('studentDisplayName').textContent = studentProfile?.name || '';
  $('planNotice').hidden = active; $('planNotice').textContent = studentProfile?.message || '';
  $('scheduleCard').hidden = !active;
  $('bookingView').querySelector('.booking-layout').style.gridTemplateColumns = active ? '' : '1fr';
  if (REMOTE) { $('studentName').required = false; $('studentPhone').required = false; $('localStudentFields').hidden = true; }
  else $('localStudentFields').hidden = false;
  $('accountPlan').textContent = studentProfile?.plan || '';
  $('accountExpiry').textContent = studentProfile?.expiresAt ? 'Válido até ' + formatDate(studentProfile.expiresAt) : (studentProfile ? 'Plano sem data de vencimento' : '');
  if (!active) { remoteAvailability = []; selectedSlotId = ''; renderAvailable(); }
}
async function loadStudentSession() {
  if (!REMOTE) return true;
  const response = await fetch('/api/student/session');
  if (!response.ok) { studentAuthenticated = false; studentProfile = null; return false; }
  const data = await response.json(); studentProfile = data.student; studentAuthenticated = true;
  applyStudentStatus(); await loadStudentBookings(); return true;
}

function render() {
  const query = $('search').value.toLowerCase(), filter = $('filter').value;
  const list = students.filter(student => (filter === 'Inativo' ? (student.status !== 'Ativo' || (!!student.expiresAt && student.expiresAt < isoToday())) : (filter === 'all' || student.status === filter)) &&
    `${student.name} ${student.phone} ${student.email} ${student.plan}`.toLowerCase().includes(query));
  const activeStudents = students.filter(student => student.status === 'Ativo' && (!student.expiresAt || student.expiresAt >= isoToday()));
  $('total').textContent = students.length; $('active').textContent = activeStudents.length;
  $('trial').textContent = students.filter(student => student.status === 'Experimental').length;
  $('revenue').innerHTML = money(activeStudents.reduce((total, student) => total + (Number(student.fee) || 0), 0)) + '<small>estimado</small>';
  $('countLabel').textContent = `${list.length} ${list.length === 1 ? 'aluno' : 'alunos'}`;
  $('rows').innerHTML = list.map(student => {
    const expired = !!student.expiresAt && student.expiresAt < isoToday();
    const status = expired || student.status === 'Pausado' ? 'Inativo' : student.status;
    const account = studentAccounts.find(item => item.studentId === student.id);
    const accountLabel = account?.hasAccount ? 'Conta criada' : (student.email ? 'Pode se cadastrar' : 'Cadastre e-mail');
    return `<tr>
    <td><div class="person"><div class="avatar">${esc(student.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase())}</div><div><b>${esc(student.name)}</b><small>${esc(student.email || 'Sem e-mail')}</small></div></div></td>
    <td>${esc(student.phone)}</td><td>${esc(student.plan)}</td><td>${esc(student.schedule || '—')}</td><td>${student.fee ? money(student.fee) : '—'}</td>
    <td>${student.expiresAt ? formatDate(student.expiresAt) : '—'}</td>
    <td><span class="pill ${status === 'Ativo' ? 'active' : status === 'Experimental' ? 'trial' : 'paused'}">${esc(status)}</span></td>
    <td><small class="account-state">${accountLabel}</small></td>
    <td><div class="row-actions"><button class="icon-btn" title="Editar" aria-label="Editar ${esc(student.name)}" onclick="editStudent('${student.id}')">✎</button><button class="icon-btn" title="Excluir" aria-label="Excluir ${esc(student.name)}" onclick="deleteStudent('${student.id}')">⌫</button></div></td>
  </tr>`;
  }).join('');
  $('empty').hidden = list.length > 0;
  renderSlotsAdmin(); renderBookingsAdmin(); renderAvailable(); renderMyBookings();
}

function renderSlotsAdmin() {
  $('slotRows').innerHTML = slots.slice().sort((a, b) => a.day - b.day || a.start.localeCompare(b.start)).map(slot => `<tr>
    <td>${dayNames[slot.day]}</td><td>${slot.start}–${slot.end}</td><td>${slot.capacity}</td>
    <td><span class="pill ${slot.open ? 'active' : 'paused'}">${slot.open ? 'Aberto' : 'Fechado'}</span></td>
    <td><div class="row-actions"><button class="slot-action" onclick="toggleSlot('${slot.id}')">${slot.open ? 'Fechar' : 'Abrir'}</button><button class="slot-action danger" onclick="removeSlot('${slot.id}')">Excluir</button></div></td>
  </tr>`).join('');
  $('slotEmpty').hidden = slots.length > 0;
}
function formatDate(date) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
}
function renderBookingsAdmin() {
  const sorted = bookings.slice().sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  $('reservationRows').innerHTML = sorted.map(booking => `<tr><td>${formatDate(booking.date)}</td><td>${booking.start}–${booking.end}</td><td>${esc(booking.name)}</td><td>${esc(booking.phone)}</td><td><button class="slot-action danger" onclick="cancelBooking('${booking.id}')">Cancelar</button></td></tr>`).join('');
  $('reservationEmpty').hidden = sorted.length > 0;
}
function renderAvailable() {
  const date = $('bookingDate').value;
  if (!date) return;
  let entries;
  if (REMOTE) entries = studentProfile?.active ? remoteAvailability.filter(slot => slot.remaining > 0) : [];
  else {
    const day = new Date(date + 'T12:00:00').getDay();
    entries = slots.filter(slot => slot.open && Number(slot.day) === day).sort((a, b) => a.start.localeCompare(b.start))
      .map(slot => ({ ...slot, remaining: slot.capacity - bookings.filter(item => item.date === date && item.slotId === slot.id).length }))
      .filter(slot => slot.remaining > 0);
  }
  $('availableSlots').innerHTML = entries.map(slot => `<button type="button" class="slot-card ${selectedSlotId === slot.id ? 'chosen' : ''}" onclick="chooseSlot('${slot.id}')"><b>${slot.start} – ${slot.end}</b><small>${dayNames[slot.day]}</small><div class="seat">${slot.remaining} ${slot.remaining === 1 ? 'vaga' : 'vagas'} restantes</div></button>`).join('');
  $('noSlots').hidden = entries.length > 0;
}

function renderMyBookings() {
  if (REMOTE) {
    $('myBookings').className = studentBookings.length ? '' : 'empty';
    $('myBookings').style.padding = studentBookings.length ? '' : '20px 0';
    $('myBookings').innerHTML = studentBookings.length
      ? studentBookings.map(item => `<div class="booking-item"><span><b>${formatDate(item.date)}</b><br>${item.start}–${item.end}</span><span>Reservada ✓</span></div>`).join('')
      : 'Você não tem próximas aulas reservadas.';
    return;
  }
  const phone = digits($('studentPhone')?.value);
  const mine = bookings.filter(item => digits(item.phone) === phone && item.date >= isoToday()).sort((a, b) => a.date.localeCompare(b.date));
  $('myBookings').className = mine.length ? '' : 'empty';
  $('myBookings').style.padding = mine.length ? '' : '20px 0';
  $('myBookings').innerHTML = mine.length ? mine.map(item => `<div class="booking-item"><span><b>${formatDate(item.date)}</b><br>${item.start}–${item.end}</span><span>Reservada ✓</span></div>`).join('') : 'Você não tem próximas aulas reservadas.';
}

function openForm(student) {
  $('studentForm').reset(); $('studentId').value = student?.id || '';
  $('formTitle').textContent = student ? 'Editar aluno' : 'Novo aluno';
  if (student) for (const key of ['name', 'phone', 'email', 'plan', 'fee', 'schedule', 'status', 'notes', 'expiresAt']) $(key).value = key === 'status' && student[key] === 'Pausado' ? 'Inativo' : (student[key] || '');
  $('modalBack').classList.add('open'); $('name').focus();
}
function closeForm() { $('modalBack').classList.remove('open'); }
window.editStudent = id => { const student = students.find(item => item.id === id); if (student) openForm(student); };
window.deleteStudent = id => {
  const student = students.find(item => item.id === id);
  if (student && confirm(`Excluir o cadastro de ${student.name}? O acesso e as reservas dessa conta também deixarão de funcionar.`)) {
    students = students.filter(item => item.id !== id); persist(); showToast('Cadastro removido.');
  }
};
window.chooseSlot = id => { selectedSlotId = id; renderAvailable(); };
window.toggleSlot = id => {
  const slot = slots.find(item => item.id === id);
  if (slot) { slot.open = !slot.open; persist(); showToast(slot.open ? 'Horário aberto para reservas.' : 'Horário fechado para reservas.'); }
};
window.removeSlot = id => {
  if (confirm('Excluir este horário da agenda?')) { slots = slots.filter(item => item.id !== id); if (selectedSlotId === id) selectedSlotId = ''; persist(); }
};
window.cancelBooking = async id => {
  if (!confirm('Cancelar esta reserva?')) return;
  if (REMOTE) {
    const response = await fetch('/api/admin/bookings/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!response.ok) { showToast('Não foi possível cancelar a reserva.'); return; }
  }
  bookings = bookings.filter(item => item.id !== id); persist(); showToast('Reserva cancelada.');
};
window.switchMode = mode => {
  if (mode === 'admin' && REMOTE && !adminAuthenticated) { $('loginBack').classList.add('open'); return; }
  document.querySelectorAll('.admin-only').forEach(element => { element.style.display = mode === 'admin' ? '' : 'none'; });
  $('adminTab').classList.toggle('selected', mode === 'admin'); $('studentTab').classList.toggle('selected', mode === 'student');
  if (mode === 'student') {
    $('bookingDate').min = isoToday();
    if (!$('bookingDate').value || $('bookingDate').value < isoToday()) $('bookingDate').value = isoToday();
    if (REMOTE && !studentAuthenticated) { $('studentGate').hidden = false; $('bookingView').hidden = true; }
    else {
      $('studentGate').hidden = true; $('bookingView').hidden = false;
      if (studentProfile || !REMOTE) applyStudentStatus();
      selectedSlotId = ''; loadPublicAvailability(); renderMyBookings();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else { $('studentGate').hidden = true; $('bookingView').hidden = true; }
};
window.setStudentAuthMode = mode => {
  const register = mode === 'register';
  $('studentLoginForm').hidden = register; $('studentRegisterForm').hidden = !register;
  $('studentLoginTab').classList.toggle('selected', !register); $('studentRegisterTab').classList.toggle('selected', register);
  $('studentAuthError').textContent = ''; $('studentRegisterError').textContent = '';
};
window.studentLogout = async () => {
  if (REMOTE) await fetch('/api/student/logout', { method: 'POST' }).catch(() => {});
  studentAuthenticated = false; studentProfile = null; studentBookings = []; remoteAvailability = []; switchMode('student');
};
window.registerStudent = async event => {
  event.preventDefault(); $('studentRegisterError').textContent = '';
  const password = $('registerPassword').value;
  if (password !== $('registerPasswordConfirm').value) { $('studentRegisterError').textContent = 'As senhas não coincidem.'; return; }
  try {
    const response = await fetch('/api/student/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('registerEmail').value.trim(), phone: $('registerPhone').value.trim(), password }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Não foi possível criar a conta.');
    studentProfile = data.student; studentAuthenticated = true; $('studentRegisterForm').reset();
    await loadStudentSession(); switchMode('student');
  } catch (error) { $('studentRegisterError').textContent = error.message; }
};
window.loginStudent = async event => {
  event.preventDefault(); $('studentAuthError').textContent = '';
  try {
    const response = await fetch('/api/student/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('studentLoginEmail').value.trim(), password: $('studentLoginPassword').value }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Não foi possível entrar.');
    studentProfile = data.student; studentAuthenticated = true; $('studentLoginForm').reset();
    await loadStudentSession(); switchMode('student');
  } catch (error) { $('studentAuthError').textContent = error.message; }
};

window.shareStudentLink = async () => {
  if (!REMOTE) { showToast('O link do aluno estará pronto quando o site estiver publicado.'); return; }
  const link = `${location.origin}${location.pathname}?aluno`;
  try { await navigator.clipboard.writeText(link); showToast('Link da área do aluno copiado.'); }
  catch { window.prompt('Copie o link da área do aluno:', link); }
};

$('studentForm').addEventListener('submit', event => {
  event.preventDefault();
  const id = $('studentId').value;
  const student = { id: id || crypto.randomUUID(), ...Object.fromEntries(['name', 'phone', 'email', 'plan', 'fee', 'schedule', 'status', 'notes', 'expiresAt'].map(key => [key, $(key).value.trim()])) };
  const index = students.findIndex(item => item.id === id);
  if (index < 0) students.unshift(student); else students[index] = student;
  persist(); closeForm(); showToast(index < 0 ? 'Aluno cadastrado com sucesso.' : 'Cadastro atualizado.');
});
$('addBtn').onclick = () => openForm();
$('closeBtn').onclick = $('cancelBtn').onclick = closeForm;
$('modalBack').onclick = event => { if (event.target === $('modalBack')) closeForm(); };
document.onkeydown = event => { if (event.key === 'Escape') { closeForm(); $('loginBack').classList.remove('open'); } };
$('search').oninput = render; $('filter').onchange = render;
$('exportBtn').onclick = () => {
  if (!students.length) { showToast('Cadastre alunos antes de exportar.'); return; }
  const fields = ['name', 'phone', 'email', 'plan', 'schedule', 'fee', 'status', 'notes'];
  const heading = ['Nome', 'WhatsApp', 'E-mail', 'Plano', 'Horários', 'Mensalidade', 'Status', 'Observações'];
  const csv = [heading, ...students.map(student => fields.map(key => student[key] || ''))]
    .map(row => row.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(';')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  link.download = 'alunos-bravo-futevolei.csv'; link.click(); URL.revokeObjectURL(link.href); showToast('Lista exportada em CSV.');
};
$('slotForm').addEventListener('submit', event => {
  event.preventDefault();
  const day = Number($('slotDay').value), start = $('slotStart').value, end = $('slotEnd').value, capacity = Number($('slotCapacity').value);
  if (end <= start) { showToast('O horário de término precisa ser depois do início.'); return; }
  if (slots.some(slot => slot.day === day && start < slot.end && slot.start < end)) { showToast('Esse horário se sobrepõe a outro da agenda.'); return; }
  slots.push({ id: crypto.randomUUID(), day, start, end, capacity, open: true }); persist(); showToast('Horário aberto para reservas.');
});
$('bookingDate').min = isoToday(); $('bookingDate').value = isoToday();
$('bookingDate').onchange = () => { selectedSlotId = ''; loadPublicAvailability(); };
if ($('studentPhone')) $('studentPhone').oninput = renderMyBookings;
$('studentLoginForm').addEventListener('submit', loginStudent);
$('studentRegisterForm').addEventListener('submit', registerStudent);
$('studentLoginTab').onclick = () => setStudentAuthMode('login');
$('studentRegisterTab').onclick = () => setStudentAuthMode('register');
$('studentLogout').onclick = studentLogout;
$('schoolLoginLink').onclick = () => switchMode('admin');
$('bookingForm').addEventListener('submit', async event => {
  event.preventDefault();
  const date = $('bookingDate').value;
  const name = $('studentName')?.value.trim() || studentProfile?.name || '';
  const phone = $('studentPhone')?.value.trim() || '';
  if (REMOTE && !studentProfile?.active) { showToast(studentProfile?.message || 'Seu plano está inativo.'); return; }
  if (!selectedSlotId) { showToast('Escolha um horário disponível.'); return; }
  if (!date || date < isoToday()) { showToast('Escolha uma data válida.'); return; }
  if (!REMOTE && digits(phone).length < 10) { showToast('Informe um WhatsApp válido.'); return; }
  const slot = (REMOTE ? remoteAvailability : slots).find(item => item.id === selectedSlotId && item.open !== false);
  if (!slot) { showToast('Este horário não está mais disponível.'); await loadPublicAvailability(); return; }
  let message;
  if (REMOTE) {
    const response = await fetch('/api/student/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, slotId: selectedSlotId }) });
    const data = await response.json();
    if (!response.ok) { showToast(data.error || 'Não foi possível confirmar a reserva.'); await loadPublicAvailability(); return; }
    message = `Reserva confirmada para ${formatDate(date)}, das ${data.booking.start} às ${data.booking.end}.`;
    await loadStudentBookings();
  } else {
    const weekday = new Date(date + 'T12:00:00').getDay();
    const used = bookings.filter(item => item.date === date && item.slotId === slot.id).length;
    if (weekday !== slot.day || used >= slot.capacity) { selectedSlotId = ''; renderAvailable(); showToast('Esse horário não está mais disponível.'); return; }
    if (bookings.some(item => item.date === date && item.slotId === slot.id && digits(item.phone) === digits(phone))) { showToast('Você já reservou este horário.'); return; }
    bookings.push({ id: crypto.randomUUID(), slotId: slot.id, date, start: slot.start, end: slot.end, name, phone });
    if (!students.some(student => digits(student.phone) === digits(phone))) students.unshift({ id: crypto.randomUUID(), name, phone, email: '', plan: 'Aula experimental', fee: '', schedule: `${dayNames[slot.day]} · ${slot.start}`, status: 'Experimental', notes: 'Cadastro criado pelo agendamento online' });
    cacheLocally(); message = `Reserva confirmada para ${formatDate(date)}, das ${slot.start} às ${slot.end}.`;
  }
  $('bookingSuccess').textContent = message; $('bookingSuccess').classList.add('show'); selectedSlotId = '';
  if (REMOTE) await loadPublicAvailability(); else render();
  showToast('Aula reservada com sucesso.');
});

$('loginClose').onclick = () => $('loginBack').classList.remove('open');
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginError').textContent = '';
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('adminPassword').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Senha incorreta.');
    adminAuthenticated = true; $('loginBack').classList.remove('open'); $('adminPassword').value = '';
    await loadAdminState(); switchMode('admin');
  } catch (error) { $('loginError').textContent = error.message; }
});

async function boot() {
  const studentLink = new URLSearchParams(location.search).has('aluno');
  if (REMOTE) {
    try {
      const sessionResponse = await fetch('/api/session');
      adminAuthenticated = !!(await sessionResponse.json()).authenticated;
      if (adminAuthenticated && !studentLink) {
        await loadAdminState(); switchMode('admin'); return;
      }
    } catch { adminAuthenticated = false; }
    await loadStudentSession().catch(() => false);
    switchMode('student');
  } else if (studentLink) switchMode('student');
  else switchMode('admin');
}

$('today').textContent = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
render(); boot();
setInterval(() => {
  if (REMOTE && adminAuthenticated && $('bookingView').hidden) loadAdminState().catch(() => {});
}, 20000);
