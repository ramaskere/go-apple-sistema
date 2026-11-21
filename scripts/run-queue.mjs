// Publica lo que esté en cola.json y ya haya llegado a su hora. Cada pieza fue aprobada por Rama al encolarla.
import { makeApi, publish, publishStory } from './lib-ig.mjs';
const { META_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
for (const [k, v] of Object.entries({ META_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY })) if (!v) throw new Error('Falta la variable ' + k);
const URL_Q = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/cola.json`;
const MAX_ATRASO_H = 6; // si se pasó más de esto, no se publica (queda como "vencido")
const gh = (url, opt = {}) => fetch(url, { ...opt, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + GITHUB_TOKEN } });

async function read() {
  const r = await gh(URL_Q + '?t=' + Date.now());
  if (r.status === 404) return { items: [], sha: null };
  if (!r.ok) throw new Error('GitHub ' + r.status + ' al leer la cola.');
  const j = await r.json();
  return { items: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
async function write(items, sha, msg) {
  const body = { message: msg, content: Buffer.from(JSON.stringify(items, null, 2) + '\n').toString('base64'), ...(sha ? { sha } : {}) };
  const r = await gh(URL_Q, { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok) throw new Error('GitHub ' + r.status + ' al guardar la cola.');
  return (await r.json()).content.sha;
}

let { items, sha } = await read();
const now = Date.now(), api = makeApi(META_TOKEN);
const due = items.filter(i => i.estado === 'pendiente' && new Date(i.fecha).getTime() <= now);
if (!due.length) { console.log('Nada para publicar.'); process.exit(0); }

for (const it of due) {
  const atrasoH = (now - new Date(it.fecha).getTime()) / 36e5;
  if (atrasoH > MAX_ATRASO_H) { it.estado = 'vencido'; sha = await write(items, sha, 'Cola: vencido ' + it.id); console.log('Vencido:', it.id); continue; }
  it.estado = 'publicando'; sha = await write(items, sha, 'Cola: publicando ' + it.id); // evita duplicados si algo se corta
  try {
    if (it.tipo === 'historia') { await publishStory(api, (it.imagenes || [])[0], it.cuenta); it.link = ''; } // sin cuenta: la principal
    else it.link = await publish(api, it.imagenes, it.caption, it.cuenta);
    it.estado = 'publicado'; it.publicado = new Date().toISOString();
    console.log('Publicado:', it.id, it.tipo === 'historia' ? '(historia)' : it.link);
  } catch (e) {
    it.estado = 'error'; it.error = e.message.slice(0, 300);
    console.error('Error en', it.id + ':', it.error);
  }
  sha = await write(items, sha, 'Cola: ' + it.estado + ' ' + it.id);
}
if (items.some(i => i.estado === 'error')) process.exitCode = 1;
