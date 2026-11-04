'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runReminders, whatsappPhone } = require('../reminders');
const env = { WHATSAPP_REMINDERS_ENABLED: 'true', WHATSAPP_ACCESS_TOKEN: 'test-only', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_TEMPLATE_NAME: 'mensalidade_vencida', WHATSAPP_GRAPH_VERSION: 'v99.0' };
const now = new Date('2026-11-04T12:00:00Z');
function harness(students) {
  let data = { students, reminders: {} };
  return { readData: () => structuredClone(data), saveData: value => { data = structuredClone(value); }, env, now };
}
const student = { id: 'a', name: 'Aluno', phone: '(11) 99999-9999', fee: 250.50, expiresAt: '2026-11-03', status: 'Ativo' };
test('only overdue active students receive a notice; never repeat same due date', async () => {
  const h = harness([student, { ...student, id: 'b', status: 'Inativo' }, { ...student, id: 'c', expiresAt: '2026-11-04' }, { ...student, id: 'd', expiresAt: '2026-11-05' }]);
  const calls = [];
  h.fetchImpl = async (url, request) => { calls.push(JSON.parse(request.body)); return { ok: true, json: async () => ({ messages: [{ id: 'accepted-test' }] }) }; };
  await runReminders(h); await runReminders(h);
  assert.equal(calls.length, 1); assert.equal(calls[0].to, '5511999999999');
  assert.equal(calls[0].template.components[0].parameters[1].text, '03/11/2026');
  assert.equal(Object.values(h.readData().reminders)[0].status, 'accepted');
  const data = h.readData(); data.students[0].expiresAt = '2026-11-02'; h.saveData(data);
  await runReminders(h); assert.equal(calls.length, 2);
});
test('disabled or missing credentials never send', async () => {
  const h = harness([student]); h.fetchImpl = async () => { throw Error('should not send'); };
  h.env = {}; await runReminders(h); assert.deepEqual(h.readData().reminders, {});
});
test('unknown delivery outcome is recorded without retrying', async () => {
  const h = harness([student]); let calls = 0; h.fetchImpl = async () => { calls++; throw Error('timeout'); };
  await runReminders(h); await runReminders(h);
  assert.equal(calls, 1); assert.equal(Object.values(h.readData().reminders)[0].status, 'unknown');
});
test('provider rejection records failure', async () => {
  const h = harness([student]); h.fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({}) });
  await runReminders(h); assert.equal(Object.values(h.readData().reminders)[0].status, 'failed');
});
test('Brazilian date and invalid phone are respected', async () => {
  const h = harness([student]); h.now = new Date('2026-11-04T01:00:00Z'); h.fetchImpl = async () => { throw Error('not overdue in Brazil'); };
  await runReminders(h); assert.deepEqual(h.readData().reminders, {});
  assert.equal(whatsappPhone('123'), null); assert.equal(whatsappPhone('+55 11 99999-9999'), '5511999999999');
});

test('connection verification queries number without sending messages or returning the token', async () => {
  const { verifyWhatsAppConnection } = require('../reminders');
  const result = await verifyWhatsAppConnection({ env, fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/123?fields=display_phone_number,verified_name'));
    assert.equal(options.method, undefined);
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    return { ok: true, json: async () => ({ id: '123', display_phone_number: '+55 11 99999-9999', verified_name: 'Bravo' }) };
  } });
  assert.equal(result.connected, true);
  assert.equal(result.name, 'Bravo');
  assert.ok(!JSON.stringify(result).includes('test-only'));
});
test('connection with missing credentials is not described as connected', async () => {
  const { verifyWhatsAppConnection } = require('../reminders');
  const result = await verifyWhatsAppConnection({ env: {}, fetchImpl: async () => { throw Error('must not request'); } });
  assert.equal(result.connected, false); assert.ok(result.missing.includes('WHATSAPP_ACCESS_TOKEN'));
});
test('provider denial and network errors do not expose external error bodies', async () => {
  const { verifyWhatsAppConnection } = require('../reminders');
  const denied = await verifyWhatsAppConnection({ env, fetchImpl: async () => ({ ok: false, json: async () => ({ secret: 'never-expose' }) }) });
  assert.equal(denied.connected, false); assert.ok(!JSON.stringify(denied).includes('never-expose'));
  const offline = await verifyWhatsAppConnection({ env, fetchImpl: async () => { throw Error('private details'); } });
  assert.equal(offline.connected, false); assert.ok(!JSON.stringify(offline).includes('private details'));
});
