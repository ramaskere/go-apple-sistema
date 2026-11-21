// Lecturas de prueba con el token existente (inicio de sesión con Facebook). Solo lectura, sin nombres ni IDs en los logs.
const T = process.env.META_TOKEN;
if (!T) throw new Error('Falta META_TOKEN');
const G = 'https://graph.facebook.com/v21.0';
async function get(path, params = {}, token = T) {
  const q = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${G}/${path}?${q}`), j = await r.json();
  return { ok: r.ok, status: r.status, j };
}
const err = r => `error ${r.status}: ${r.j.error?.message || 'desconocido'}`;
const want = (process.env.IG_USERNAME || 'goapple.sj').toLowerCase();
const pages = (await get('me/accounts', { fields: 'id,access_token,instagram_business_account{id,username}' })).j.data || [];
const page = pages.find(p => (p.instagram_business_account?.username || '').toLowerCase() === want);
if (!page) throw new Error('No encontré la página vinculada.');
const tk = page.access_token || T, ig = page.instagram_business_account.id;

const media = await get(`${ig}/media`, { fields: 'id', limit: '10' }, tk);
let okC = false, n = 0;
for (const m of media.j.data || []) { const c = await get(`${m.id}/comments`, { fields: 'id', limit: '50' }, tk); if (c.ok) { okC = true; n += (c.j.data || []).length; } else console.log('Comentarios:', err(c)); }
console.log('instagram_manage_comments:', okC ? 'llamada ok, comentarios visibles: ' + n : 'sin llamada exitosa');

const conv = await get(`${page.id}/conversations`, { platform: 'instagram', limit: '10' }, tk);
console.log('instagram_manage_messages (conversaciones):', conv.ok ? 'llamada ok, ' + (conv.j.data || []).length : err(conv));
process.exit(okC && conv.ok ? 0 : 1);
