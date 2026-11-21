// Responde comentarios con palabra clave y envía el recurso en un único mensaje privado (respuesta privada al comentario).
// Lee recursos y el interruptor de datos.enc.json (cifrado con DATA_PASS). Con el interruptor apagado solo informa (modo prueba).
// Los logs son públicos: solo cantidades, nunca nombres, IDs ni textos.
const { DATA_PASS, META_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
for (const [k, v] of Object.entries({ DATA_PASS, META_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY })) if (!v) throw new Error('Falta la variable ' + k);
const MAX_ENVIOS = 15, DIA = 864e5;
const FILE = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/datos.enc.json`;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = u => Buffer.from(u).toString('base64'), unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
async function key(salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(DATA_PASS), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const gh = (url, opt = {}) => fetch(url, { ...opt, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + GITHUB_TOKEN } });
async function load() {
  const r = await gh(FILE + '?t=' + Date.now());
  if (r.status === 404) return { data: {}, sha: null, salt: crypto.getRandomValues(new Uint8Array(16)) };
  if (!r.ok) throw new Error('GitHub ' + r.status + ' al leer.');
  const j = await r.json(), f = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  try { return { data: JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv) }, await key(unb64(f.salt)), unb64(f.ct)))), sha: j.sha, salt: unb64(f.salt) }; }
  catch { throw new Error('DATA_PASS no coincide con la contraseña de los datos.'); }
}
// Lee, aplica el cambio sobre datos frescos y guarda; reintenta ante conflicto.
async function mutate(fn) {
  for (let i = 0; i < 4; i++) {
    const { data, sha, salt } = await load();
    fn(data);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(salt), enc.encode(JSON.stringify(data)));
    const content = Buffer.from(JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) })).toString('base64');
    const w = await gh(FILE, { method: 'PUT', body: JSON.stringify({ message: 'Bot de comentarios', content, ...(sha ? { sha } : {}) }) });
    if (w.ok) return;
    if (w.status !== 409 && w.status !== 422) throw new Error('GitHub ' + w.status + ' al guardar.');
  }
  throw new Error('Conflictos repetidos al guardar.');
}

const G = 'https://graph.facebook.com/v21.0';
async function g(path, method = 'GET', params = {}, token = META_TOKEN) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = method === 'GET' ? await fetch(`${G}/${path}?${body}`) : await fetch(`${G}/${path}`, { method, body });
  const j = await r.json();
  return { ok: r.ok, status: r.status, j };
}
const norm = t => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Una letra de diferencia (sustitución, falta o sobra), sin tocar palabras cortas.
const lev1 = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [c, l] = a.length < b.length ? [a, b] : [b, a];
  return c.slice(i) === l.slice(i + 1);
};
// El campo "palabra" admite varias claves separadas por coma o por línea. Se ignoran mayúsculas, tildes, letras repetidas 3+ veces,
// plural con "s", y una letra de error en claves de una sola palabra de 5 o más letras. Las frases deben coincidir exactas.
const claves = r => String(r.palabra || '').split(/[,\n]/).map(x => norm(x).replace(/\s+/g, ' ').trim()).filter(Boolean);
const coincide = (rec, texto) => {
  const t = norm(texto).replace(/(.)\1{2,}/g, '$1').replace(/\s+/g, ' ');
  const tokens = t.split(/[^a-z0-9]+/).filter(Boolean);
  return claves(rec).some(k => {
    if (k.includes(' ')) return new RegExp('(^|[^a-z0-9])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])').test(t);
    if (tokens.some(w => w === k || w === k + 's')) return true;
    return k.length >= 5 && tokens.some(w => lev1(w, k));
  });
};

const { data } = await load();
// El interruptor es por cuenta (data.config.auto.cuentas[cuenta]); si esa cuenta no tiene un valor propio
// todavía, se usa data.config.auto.activo (el interruptor global de antes) como valor de respaldo.
const autoFor = cuenta => {
  const a = data.config?.auto || {};
  if (a.cuentas && Object.prototype.hasOwnProperty.call(a.cuentas, cuenta)) return !!a.cuentas[cuenta];
  return !!a.activo;
};
const recursos = Object.entries(data.recursos || {}).map(([id, r]) => ({ id, ...r })).filter(r => r.estado === 'Activo' && r.palabra && r.dm);
console.log(`Recursos activos: ${recursos.length}`);
if (!recursos.length) process.exit(0);
const cuentas = (data.config?.cuentas?.lista || [process.env.IG_USERNAME || 'goapple.sj']).map(x => String(x).toLowerCase());
const cuentaDe = r => String(r.cuenta || cuentas[0]).toLowerCase();

async function procesar(want) {
const auto = autoFor(want);
const recs = recursos.filter(r => cuentaDe(r) === want);
console.log(`Modo: ${auto ? 'automático' : 'prueba (no envía)'} | recursos de esta cuenta: ${recs.length}`);
if (!recs.length) { console.log('Sin recursos activos en esta cuenta.'); return; }
const pages = (await g('me/accounts', 'GET', { fields: 'id,access_token,instagram_business_account{id,username}' })).j.data || [];
const page = pages.find(p => (p.instagram_business_account?.username || '').toLowerCase() === want);
if (!page) { console.log('No encontré la página vinculada a esta cuenta.'); return; }
const tk = page.access_token || META_TOKEN, ig = page.instagram_business_account.id;
const own0 = new Set([ig, page.id]);
async function enviar(recipient, text) {
  const body = { recipient: JSON.stringify(recipient), message: JSON.stringify({ text }) };
  let r = await g(`${page.id}/messages`, 'POST', body, tk);
  if (!r.ok) r = await g(`${ig}/messages`, 'POST', body);
  return r;
}
// Un campo con varias líneas se interpreta como variantes: se elige una al azar.
const elegir = t => { const l = String(t || '').split('\n').map(x => x.trim()).filter(Boolean); return l.length ? l[Math.floor(Math.random() * l.length)] : ''; };
const falla = r => `error ${r.status} (código ${r.j.error?.code}/${r.j.error?.error_subcode || '-'}): ${r.j.error?.message}`;

/* 1. Comentarios nuevos con palabra clave */
const atendidos = data.atendidos || {};
const media = (await g(`${ig}/media`, 'GET', { fields: 'id', limit: '10' }, tk)).j.data || [];
let leidos = 0, coinciden = 0, enviados = 0, bloqueados = 0;
for (const m of media) {
  const c = await g(`${m.id}/comments`, 'GET', { fields: 'id,text,timestamp,username', limit: '50' }, tk);
  for (const x of c.j.data || []) {
    leidos++;
    if (atendidos[x.id] || (x.username || '').toLowerCase() === want || Date.now() - new Date(x.timestamp) > 7 * DIA) continue;
    const rec = recs.find(r => coincide(r, x.text) && (!r.post || r.post === 'post:ig-' + m.id));
    if (!rec) continue;
    coinciden++;
    if (!auto) continue;
    if (/\[LINK\]/i.test(rec.dm)) { bloqueados++; continue; }
    if (enviados >= MAX_ENVIOS) continue;
    const primero = [elegir(rec.saludos), rec.dm, rec.pregunta].filter(Boolean).join('\n\n'); // un solo mensaje: saludo (variable), recurso y, si hay, la pregunta al final
    const pr = await enviar({ comment_id: x.id }, primero);
    if (!pr.ok) {
      console.log('Respuesta privada falló:', falla(pr));
      await mutate(d => { (d.atendidos ||= {})[x.id] = { recurso: rec.id, estado: 'error', ts: Date.now() }; });
      continue;
    }
    const textoPublico = elegir(rec.respuesta);
    if (textoPublico) { const pub = await g(`${x.id}/replies`, 'POST', { message: textoPublico }, tk); if (!pub.ok) console.log('Respuesta pública falló:', falla(pub)); }
    const sid = pr.j.recipient_id;
    await mutate(d => {
      (d.atendidos ||= {})[x.id] = { recurso: rec.id, estado: 'entregado', sid, user: x.username || '', ts: Date.now() };
      const r = d.recursos[rec.id]; r.comentarios = (r.comentarios || 0) + 1; r.enviados = (r.enviados || 0) + 1;
    });
    enviados++;
  }
}
console.log(`Comentarios leídos: ${leidos} | con palabra clave: ${coinciden} | respuestas enviadas: ${enviados}${bloqueados ? ' | sin enviar por [LINK] pendiente: ' + bloqueados : ''}`);
}
let n = 0;
for (const c of cuentas) { console.log(`Cuenta ${++n} de ${cuentas.length}`); await procesar(c).catch(e => console.log('Error:', e.message)); }
