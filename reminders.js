'use strict';

// Persistent delivery ledger prevents repeated notices for the same due date.
const crypto = require('node:crypto');
function reminderConfig(env = process.env) {
  const names = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE_NAME', 'WHATSAPP_GRAPH_VERSION'];
  const missing = names.filter(name => !env[name]);
  return { enabled: env.WHATSAPP_REMINDERS_ENABLED === 'true', missing,
    ready: env.WHATSAPP_REMINDERS_ENABLED === 'true' && missing.length === 0 };
}
function brazilDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function whatsappPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  // Local Brazilian numbers include DDD; international numbers must include 55.
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  if (/^55\d{10,11}$/.test(digits)) return digits;
  return null;
}
async function runReminders({ readData, saveData, env = process.env, fetchImpl = fetch, now = new Date() }) {
  if (!reminderConfig(env).ready) return;
  if (!/^v\d+\.\d+$/.test(env.WHATSAPP_GRAPH_VERSION) || !/^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID)) throw new Error('Configuração do WhatsApp inválida.');
  const day = brazilDate(now);
  const candidates = (await readData()).students.filter(student => student.status === 'Ativo' && /^\d{4}-\d{2}-\d{2}$/.test(student.expiresAt || '') && student.expiresAt < day);
  for (const candidate of candidates) {
    const data = await readData();
    const student = data.students.find(item => item.id === candidate.id);
    if (!student || student.status !== 'Ativo' || student.expiresAt !== candidate.expiresAt) continue;
    const key = crypto.createHash('sha256').update(`${student.id}:${student.expiresAt}`).digest('hex');
    data.reminders ||= {};
    if (data.reminders[key]) continue;
    const to = whatsappPhone(student.phone);
    if (!to) continue;
    // Save before sending: an interrupted request must not trigger duplicate delivery.
    data.reminders[key] = { studentId: student.id, dueDate: student.expiresAt, attemptedAt: now.toISOString(), status: 'pending' };
    await saveData(data);
    let result;
    try {
      const response = await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000), body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: {
          name: env.WHATSAPP_TEMPLATE_NAME, language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE || 'pt_BR' },
          components: [{ type: 'body', parameters: [student.name, student.expiresAt.split('-').reverse().join('/'), new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(student.fee) || 0)].map(text => ({ type: 'text', text })) }]
        } })
      });
      const body = await response.json();
      result = response.ok && body.messages?.[0]?.id
        ? { status: 'accepted', messageId: body.messages[0].id }
        : { status: 'failed', httpStatus: response.status };
    } catch {
      result = { status: 'unknown' };
    }
    const latest = await readData();
    latest.reminders ||= {};
    latest.reminders[key] = { ...data.reminders[key], ...result };
    await saveData(latest);
  }
}
module.exports = { reminderConfig, runReminders, whatsappPhone };
