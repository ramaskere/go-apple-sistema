// Funciones compartidas para publicar en Instagram con la API de Meta.
const G = 'https://graph.facebook.com/v21.0';
export function makeApi(token) {
  return async function api(path, method = 'GET', params = {}) {
    const body = new URLSearchParams({ ...params, access_token: token });
    const r = method === 'GET' ? await fetch(`${G}/${path}?${body}`) : await fetch(`${G}/${path}`, { method, body });
    const j = await r.json();
    if (!r.ok) throw new Error(`Meta ${r.status} en ${path}: ${j.error?.message || 'error'}`);
    return j;
  };
}
export async function igId(api, usuario) {
  if (!usuario && process.env.IG_USER_ID) return process.env.IG_USER_ID;
  const want = (usuario || process.env.IG_USERNAME || 'goapple.sj').toLowerCase();
  const pages = (await api('me/accounts', 'GET', { fields: 'instagram_business_account{id,username}' })).data || [];
  const mine = pages.map(p => p.instagram_business_account).filter(Boolean).find(a => (a.username || '').toLowerCase() === want);
  if (!mine) throw new Error('No encontré @' + want + ' entre las cuentas visibles.');
  return mine.id;
}
async function ready(api, id) {
  for (let i = 0; i < 30; i++) {
    const s = await api(id, 'GET', { fields: 'status_code' });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('Instagram no pudo procesar el contenido: ' + s.status_code);
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error('Instagram tardó demasiado en procesar el contenido.');
}
// Publica 1 imagen (post) o 2 a 10 (carrusel). Devuelve el link del post.
export async function publish(api, urls, caption, cuenta) {
  if (!urls.length) throw new Error('Falta al menos una URL de imagen.');
  if (urls.length > 10) throw new Error('Instagram admite hasta 10 imágenes por carrusel.');
  if (urls.some(u => !u.startsWith('https://'))) throw new Error('Todas las URLs deben empezar con https://');
  const ig = await igId(api, cuenta);
  let creation;
  if (urls.length === 1) creation = (await api(`${ig}/media`, 'POST', { image_url: urls[0], caption })).id;
  else {
    const kids = [];
    for (const u of urls) { const k = (await api(`${ig}/media`, 'POST', { image_url: u, is_carousel_item: 'true' })).id; await ready(api, k); kids.push(k); }
    creation = (await api(`${ig}/media`, 'POST', { media_type: 'CAROUSEL', children: kids.join(','), caption })).id;
  }
  await ready(api, creation);
  const pub = await api(`${ig}/media_publish`, 'POST', { creation_id: creation });
  const info = await api(pub.id, 'GET', { fields: 'permalink' }).catch(() => ({}));
  return info.permalink || '';
}
// Publica una historia: una sola imagen, sin caption ni carrusel.
export async function publishStory(api, url, cuenta) {
  if (!url) throw new Error('Falta la URL de la imagen.');
  if (!url.startsWith('https://')) throw new Error('La URL debe empezar con https://');
  const ig = await igId(api, cuenta);
  const creation = (await api(`${ig}/media`, 'POST', { image_url: url, media_type: 'STORIES' })).id;
  await ready(api, creation);
  await api(`${ig}/media_publish`, 'POST', { creation_id: creation });
}
