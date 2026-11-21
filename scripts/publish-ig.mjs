// Publica un post, un carrusel o una historia. Solo corre desde el workflow manual "Publicar en Instagram".
import { makeApi, publish, publishStory } from './lib-ig.mjs';
const { META_TOKEN, IMAGE_URLS, CAPTION = '', TIPO = 'feed' } = process.env;
if (!META_TOKEN) throw new Error('Falta META_TOKEN');
const urls = (IMAGE_URLS || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
if (TIPO === 'historia') {
  if (urls.length !== 1) throw new Error('Las historias admiten una sola imagen por publicación.');
  await publishStory(makeApi(META_TOKEN), urls[0], process.env.CUENTA);
  console.log('Historia publicada.');
} else {
  console.log('Publicado:', (await publish(makeApi(META_TOKEN), urls, CAPTION, process.env.CUENTA)) || '(sin link)');
}
