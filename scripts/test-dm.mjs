// Prueba de respuesta privada: busca el comentario más reciente (últimas 24 h) que contenga PALABRA en los últimos posts
// y le envía TEXTO como mensaje privado. No imprime nombres ni IDs (el repo y sus logs son públicos).
const { META_TOKEN, PALABRA, TEXTO, MODO = 'leer' } = process.env;
const norm = t => (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
if (!META_TOKEN || !PALABRA || !TEXTO) throw new Error('Faltan variables.');
const G = 'https://graph.facebook.com/v21.0';
async function call(path, method = 'GET', params = {}, token = META_TOKEN) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = method === 'GET' ? await fetch(`${G}/${path}?${body}`) : await fetch(`${G}/${path}`, { method, body });
  const j = await r.json();
  return { ok: r.ok, status: r.status, j };
}
const want = (process.env.IG_USERNAME || 'goapple.sj').toLowerCase();
const pages = (await call('me/accounts', 'GET', { fields: 'id,access_token,instagram_business_account{id,username}' })).j.data || [];
const page = pages.find(p => (p.instagram_business_account?.username || '').toLowerCase() === want);
if (!page) throw new Error('No encontré la página vinculada al Instagram.');
const ig = page.instagram_business_account.id;

const media = (await call(`${ig}/media`, 'GET', { fields: 'id,comments_count', limit: '10' })).j.data || [];
console.log('Posts revisados:', media.length, '| comentarios según el contador de Instagram:', media.reduce((a, m) => a + (m.comments_count || 0), 0));
const since = Date.now() - 24 * 36e5;
const matches = []; let scanned = 0;
for (const m of media) {
  const c = await call(`${m.id}/comments`, 'GET', { fields: 'id,text,timestamp', limit: '50' }, page.access_token || META_TOKEN);
  console.log('Token de página disponible:', page.access_token ? 'sí' : 'no', '| comentarios devueltos:', (c.j.data || []).length, c.ok ? '' : '| error ' + c.status);
  if (!c.ok) { console.log('Leer comentarios falló:', c.status, c.j.error?.message); continue; }
  for (const x of c.j.data || []) {
    scanned++;
    if (norm(x.text).includes(norm(PALABRA)) && new Date(x.timestamp).getTime() >= since) matches.push(x);
  }
}
console.log('Comentarios leídos:', scanned, '| coinciden en las últimas 24 h:', matches.length, '| antigüedad en minutos:', matches.map(x => Math.round((Date.now() - new Date(x.timestamp)) / 6e4)).join(', ') || '-');
if (MODO !== 'enviar') { console.log('Modo lectura: no se envió nada.'); process.exit(0); }
if (matches.length !== 1) { console.log('Se necesita exactamente 1 coincidencia para enviar. No se envió nada.'); process.exit(1); }
const found = matches[0];
const msg = { recipient: JSON.stringify({ comment_id: found.id }), message: JSON.stringify({ text: TEXTO }) };
let res = await call(`${page.id}/messages`, 'POST', msg, page.access_token || META_TOKEN);
console.log('Intento 1 (página):', res.ok ? 'enviado' : `error ${res.status}: ${res.j.error?.message} (código ${res.j.error?.code}/${res.j.error?.error_subcode || '-'})`);
if (!res.ok) {
  res = await call(`${ig}/messages`, 'POST', msg);
  console.log('Intento 2 (cuenta de Instagram):', res.ok ? 'enviado' : `error ${res.status}: ${res.j.error?.message} (código ${res.j.error?.code}/${res.j.error?.error_subcode || '-'})`);
}
process.exit(res.ok ? 0 : 1);
