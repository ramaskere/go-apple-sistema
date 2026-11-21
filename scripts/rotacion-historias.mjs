// Publica TODAS las imágenes de cada rotación de rotaciones.json, una vez por día, todos los días.
// Corre desde el workflow "Historias diarias" (cron cada 15 min). No toca cola.json ni datos.enc.json.
import { makeApi, publishStory } from './lib-ig.mjs';
const { META_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
for (const [k, v] of Object.entries({ META_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY })) if (!v) throw new Error('Falta la variable ' + k);
const URL_R = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/rotaciones.json`;
const gh = (url, opt = {}) => fetch(url, { ...opt, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + GITHUB_TOKEN } });

async function read() {
  const r = await gh(URL_R + '?t=' + Date.now());
  if (r.status === 404) return { data: {}, sha: null };
  if (!r.ok) throw new Error('GitHub ' + r.status + ' al leer rotaciones.');
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
async function write(data, sha, msg) {
  const body = { message: msg, content: Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64'), ...(sha ? { sha } : {}) };
  const r = await gh(URL_R, { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok) throw new Error('GitHub ' + r.status + ' al guardar rotaciones.');
  return (await r.json()).content.sha;
}

// Argentina es UTC-3 fijo (sin horario de verano).
const ahoraArt = new Date(Date.now() - 3 * 3600e3);
const hoyArt = ahoraArt.toISOString().slice(0, 10);
const horaArt = ahoraArt.toISOString().slice(11, 16);

const { data, sha } = await read();
const api = makeApi(META_TOKEN);
let cambios = 0;
for (const [id, r] of Object.entries(data)) {
  if (!r.imagenes?.length) continue;
  if (r.ultima === hoyArt) continue; // ya publicó hoy
  if (horaArt < (r.hora || '08:00')) continue; // todavía no es la hora
  try {
    for (const url of r.imagenes) await publishStory(api, url, r.cuenta);
    r.ultima = hoyArt;
    cambios++;
    console.log('Historias publicadas:', id, '(' + r.imagenes.length + ')');
  } catch (e) {
    console.error('Error en', id + ':', e.message);
  }
}
if (cambios) await write(data, sha, 'Rotación de historias: ' + hoyArt);
else console.log('Nada para publicar todavía.');
