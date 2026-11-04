'use strict';

const fs = require('node:fs');
const path = require('node:path');
const REVISION = Symbol('revision');
class StorageError extends Error {
  constructor(message, statusCode = 503) { super(message); this.statusCode = statusCode; }
}
function normalize(value) {
  if (!value || !Array.isArray(value.students)) throw new StorageError('Os dados armazenados são inválidos. Nenhum cadastro foi substituído.');
  return { ...value, students: value.students, slots: value.slots || [], bookings: value.bookings || [], studentAccounts: value.studentAccounts || [], reminders: value.reminders || {} };
}
function emptyData() { return normalize({ students: [] }); }
function createStorage({ env = process.env, fetchImpl = fetch } = {}) {
  const external = Boolean(env.SUPABASE_URL || env.SUPABASE_SECRET_KEY);
  if (external && (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY)) throw new StorageError('Configure SUPABASE_URL e SUPABASE_SECRET_KEY juntas.');
  if (external) {
    let base;
    try { base = new URL(env.SUPABASE_URL); } catch { throw new StorageError('SUPABASE_URL inválida.'); }
    if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(base.hostname) || base.username || base.password || base.port || base.pathname !== '/' || base.search || base.hash) throw new StorageError('Use a URL HTTPS do projeto Supabase, sem caminho adicional.');
    const endpoint = new URL('/rest/v1/bravo_state', base).href;
    const headers = { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' };
    // Legacy service_role keys are JWTs; modern sb_secret keys use apikey only.
    if (!env.SUPABASE_SECRET_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${env.SUPABASE_SECRET_KEY}`;
    async function request(url, options = {}) {
      let response;
      try { response = await fetchImpl(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(15000) }); }
      catch { throw new StorageError('Não foi possível conectar ao banco externo. Tente novamente; os dados não foram salvos localmente.'); }
      if (!response.ok) throw new StorageError('O banco externo recusou a operação. Confira a conexão, a chave e a tabela no Supabase.');
      try { return await response.json(); } catch { throw new StorageError('Resposta inválida do banco externo.'); }
    }
    return {
      info: { backend: 'supabase', persistent: true },
      version: data => data[REVISION],
      async readData() {
        const rows = await request(`${endpoint}?id=eq.1&select=payload,revision`);
        if (!Array.isArray(rows) || rows.length !== 1 || !Number.isSafeInteger(rows[0].revision)) throw new StorageError('A tabela do banco precisa ser preparada. Execute supabase/setup.sql no SQL Editor do projeto.');
        const data = normalize(rows[0].payload); data[REVISION] = rows[0].revision; return data;
      },
      async saveData(data) {
        const revision = data[REVISION];
        if (!Number.isSafeInteger(revision)) throw new StorageError('Recarregue os dados antes de salvar.', 409);
        const rows = await request(`${endpoint}?id=eq.1&revision=eq.${revision}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ payload: normalize(data), revision: revision + 1 }) });
        if (!Array.isArray(rows) || rows.length !== 1) throw new StorageError('Os dados foram atualizados em outra operação. Recarregue a página e tente novamente.', 409);
        data[REVISION] = revision + 1;
      }
    };
  }
  const dir = env.DATA_DIR || __dirname, file = path.join(dir, 'data.json');
  fs.mkdirSync(dir, { recursive: true });
  let revision = 0;
  return {
    info: { backend: 'file', persistent: false },
    version: data => data[REVISION],
    async readData() {
      let data;
      try { data = normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); }
      catch (error) {
        if (error.code === 'ENOENT') data = emptyData();
        else throw new StorageError('Não foi possível ler os dados locais. Nenhum cadastro foi substituído.');
      }
      data[REVISION] = revision; return data;
    },
    async saveData(data) {
      if (data[REVISION] !== revision) throw new StorageError('Os dados foram atualizados. Recarregue a página.', 409);
      const temp = file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(normalize(data), null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, file); revision++; data[REVISION] = revision;
    }
  };
}
module.exports = { createStorage, StorageError };
