// Llamadas de prueba a la API de Instagram con inicio de sesión de Instagram (graph.instagram.com).
// Sirven para que Meta registre el uso de instagram_business_basic, _manage_comments y _manage_messages.
// Solo lectura. No imprime nombres, IDs ni contenido (el repo y sus logs son públicos).
const T = process.env.IG_LOGIN_TOKEN;
if (!T) throw new Error('Falta el secreto IG_LOGIN_TOKEN.');
const G = 'https://graph.instagram.com/v21.0';
async function get(path, params = {}) {
  const q = new URLSearchParams({ ...params, access_token: T });
  const r = await fetch(`${G}/${path}?${q}`), j = await r.json();
  return { ok: r.ok, status: r.status, j };
}
const err = r => `error ${r.status}: ${r.j.error?.message || 'desconocido'}`;

const me = await get('me', { fields: 'user_id,username' });
console.log('Perfil (instagram_business_basic):', me.ok ? 'ok' : err(me));
if (!me.ok) process.exit(1);

const media = await get('me/media', { fields: 'id', limit: '10' });
console.log('Publicaciones (instagram_business_basic):', media.ok ? 'ok, ' + (media.j.data || []).length : err(media));

let comentarios = 0, okC = false;
for (const m of media.j.data || []) {
  const c = await get(`${m.id}/comments`, { fields: 'id,text,timestamp', limit: '50' });
  if (c.ok) { okC = true; comentarios += (c.j.data || []).length; } else console.log('Comentarios (instagram_business_manage_comments):', err(c));
}
console.log('Comentarios (instagram_business_manage_comments):', okC ? 'llamada ok, comentarios visibles: ' + comentarios : 'sin llamada exitosa');

const conv = await get('me/conversations', { platform: 'instagram', limit: '10' });
console.log('Conversaciones (instagram_business_manage_messages):', conv.ok ? 'llamada ok, ' + (conv.j.data || []).length : err(conv));
process.exit(okC && conv.ok ? 0 : 1);
