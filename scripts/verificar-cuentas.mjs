// Comprueba si Meta ve las cuentas de Instagram indicadas (solo sí/no: los logs son públicos).
const T = process.env.META_TOKEN, want = (process.env.CUENTAS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
if (!T) throw new Error('Falta META_TOKEN');
const q = new URLSearchParams({ fields: 'id,instagram_business_account{id,username}', access_token: T, limit: '100' });
const r = await fetch('https://graph.facebook.com/v21.0/me/accounts?' + q), j = await r.json();
if (!r.ok) throw new Error('Meta ' + r.status + ': ' + (j.error?.message || ''));
const vistas = new Set((j.data || []).map(p => (p.instagram_business_account?.username || '').toLowerCase()).filter(Boolean));
for (const u of want) console.log('Cuenta @' + u + ':', vistas.has(u) ? 'visible' : 'NO visible');
