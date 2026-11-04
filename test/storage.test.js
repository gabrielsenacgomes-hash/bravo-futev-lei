'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createStorage } = require('../storage');
const env = { SUPABASE_URL: 'https://project-test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test-only' };
function remote() {
  let row = { payload: { students: [] }, revision: 0 };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.apikey, env.SUPABASE_SECRET_KEY);
    if (options.method === 'PATCH') {
      const expected = Number(new URL(url).searchParams.get('revision').slice(3));
      if (expected !== row.revision) return { ok: true, json: async () => [] };
      row = JSON.parse(options.body);
    }
    return { ok: true, json: async () => [structuredClone(row)] };
  };
  return { fetchImpl, calls };
}
test('external data survives recreation of the storage instance and saves fees accurately', async () => {
  const mock = remote();
  const first = createStorage({ env, fetchImpl: mock.fetchImpl });
  const data = await first.readData();
  data.students.push({ id: 'student', name: 'Aluno', phone: '11999999999', fee: 250.50 });
  data.reminders.sent = { status: 'accepted' };
  await first.saveData({ ...data });
  const restarted = createStorage({ env, fetchImpl: mock.fetchImpl });
  const saved = await restarted.readData();
  assert.equal(saved.students[0].fee, 250.50);
  assert.equal(saved.reminders.sent.status, 'accepted');
  assert.equal(restarted.info.backend, 'supabase');
  assert.equal(mock.calls[1].options.headers.Prefer, 'return=representation');
  assert.equal(mock.calls[1].options.headers.Authorization, undefined);
});
test('concurrent writes cannot silently overwrite another saved revision', async () => {
  const mock = remote(), storage = createStorage({ env, fetchImpl: mock.fetchImpl });
  const a = await storage.readData(), b = await storage.readData();
  a.students.push({ id: 'first' }); b.students.push({ id: 'stale' });
  await storage.saveData(a);
  await assert.rejects(storage.saveData(b), error => error.statusCode === 409);
  assert.equal((await storage.readData()).students[0].id, 'first');
});
test('outages and missing schema fail without fallback to empty local storage', async () => {
  const storage = createStorage({ env, fetchImpl: async () => { throw Error('offline'); } });
  await assert.rejects(storage.readData(), /conectar ao banco externo/);
  const missing = createStorage({ env, fetchImpl: async () => ({ ok: true, json: async () => [] }) });
  await assert.rejects(missing.readData(), /setup.sql/);
  const denied = createStorage({ env, fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(denied.readData(), /recusou/);
});
test('partial configuration and non-project endpoints are rejected', () => {
  assert.throws(() => createStorage({ env: { SUPABASE_URL: env.SUPABASE_URL } }), /juntas/);
  assert.throws(() => createStorage({ env: { ...env, SUPABASE_URL: 'https://example.com' } }), /URL HTTPS/);
});
test('local development remains supported; corrupt data is never replaced with empty records', async () => {
  const dir = fs.mkdtempSync('/tmp/bravo-storage-');
  try {
    const storage = createStorage({ env: { DATA_DIR: dir } });
    const data = await storage.readData(); data.students.push({ id: 'local' }); await storage.saveData(data);
    assert.equal((await createStorage({ env: { DATA_DIR: dir } }).readData()).students[0].id, 'local');
    fs.writeFileSync(dir + '/data.json', 'invalid json');
    await assert.rejects(storage.readData(), /Nenhum cadastro foi substituído/);
    assert.equal(fs.readFileSync(dir + '/data.json', 'utf8'), 'invalid json');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
