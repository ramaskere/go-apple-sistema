// Aplica operaciones a datos.enc.json usando el secreto DATA_PASS (la contraseña nunca pasa por el chat).
// OPS es un JSON: [{t:'init'|'set'|'update'|'del', c:'recursos', id:'abc', d:{...}}]
// init crea el documento solo si no existe. Las operaciones viajan en los inputs del workflow, que en un repo público son visibles: no incluir links privados ni datos de personas.
const { DATA_PASS, GITHUB_TOKEN, GITHUB_REPOSITORY, OPS } = process.env;
for (const [k, v] of Object.entries({ DATA_PASS, GITHUB_TOKEN, GITHUB_REPOSITORY, OPS })) if (!v) throw new Error('Falta la variable ' + k);
const ops = JSON.parse(OPS);
const COLS = ['posts', 'camps', 'leads', 'recursos', 'config'];
for (const o of ops) if (!['init', 'set', 'update', 'del'].includes(o.t) || !COLS.includes(o.c) || !/^[\w.:-]{1,100}$/.test(o.id || '')) throw new Error('Operación no válida: ' + JSON.stringify({ t: o.t, c: o.c, id: o.id }));

const GH = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/datos.enc.json`;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = u => Buffer.from(u).toString('base64'), unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
async function key(salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(DATA_PASS), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(obj, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(salt), enc.encode(JSON.stringify(obj)))) });
}
async function decrypt(text) {
  const f = JSON.parse(text);
  try { return { data: JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv) }, await key(unb64(f.salt)), unb64(f.ct)))), salt: unb64(f.salt) }; }
  catch { throw new Error('DATA_PASS no coincide con la contraseña de los datos.'); }
}
const gh = (url, opt = {}) => fetch(url, { ...opt, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + GITHUB_TOKEN } });

for (let intento = 0; intento < 3; intento++) {
  const r = await gh(GH + '?t=' + Date.now());
  let data = { posts: {}, camps: {}, leads: {}, recursos: {}, config: {} }, sha = null, salt = crypto.getRandomValues(new Uint8Array(16));
  if (r.ok) { const j = await r.json(), d = await decrypt(Buffer.from(j.content, 'base64').toString('utf8')); data = { ...data, ...d.data }; sha = j.sha; salt = d.salt; }
  else if (r.status !== 404) throw new Error('GitHub ' + r.status + ' al leer.');
  let hechas = 0;
  for (const o of ops) {
    data[o.c] ||= {};
    if (o.t === 'init') { if (!data[o.c][o.id]) { data[o.c][o.id] = o.d; hechas++; } }
    else if (o.t === 'set') { data[o.c][o.id] = o.d; hechas++; }
    else if (o.t === 'update') { data[o.c][o.id] = { ...(data[o.c][o.id] || {}), ...o.d }; hechas++; }
    else { delete data[o.c][o.id]; hechas++; }
  }
  const body = { message: 'Actualiza datos (gestión)', content: Buffer.from(await encrypt(data, salt)).toString('base64'), ...(sha ? { sha } : {}) };
  const w = await gh(GH, { method: 'PUT', body: JSON.stringify(body) });
  if (w.ok) { console.log(`Listo: ${hechas} de ${ops.length} operaciones aplicadas. Totales -> ` + COLS.map(c => c + ': ' + Object.keys(data[c] || {}).length).join(', ')); process.exit(0); }
  if (w.status !== 409 && w.status !== 422) throw new Error('GitHub ' + w.status + ' al guardar.');
}
throw new Error('No se pudo guardar por conflictos repetidos.');
