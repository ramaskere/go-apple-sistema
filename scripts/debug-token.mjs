// Diagnóstico temporal: identidad y tipo del token, sin imprimir el valor. Se borra después de usarlo.
const { META_TOKEN } = process.env;
if (!META_TOKEN) throw new Error('Falta META_TOKEN');
const G = 'https://graph.facebook.com/v21.0';
async function g(path, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: META_TOKEN });
  const r = await fetch(`${G}/${path}?${body}`);
  const j = await r.json();
  return { status: r.status, ok: r.ok, j };
}
console.log('Largo del token:', META_TOKEN.length);
const me = await g('me', { fields: 'id,name' });
console.log('/me ->', me.status, me.ok ? JSON.stringify(me.j) : JSON.stringify(me.j.error));
const debug = await g('debug_token', { input_token: META_TOKEN });
console.log('/debug_token ->', debug.status, debug.ok ? JSON.stringify(debug.j.data) : JSON.stringify(debug.j.error));
const accounts = await g('me/accounts', { fields: 'name,instagram_business_account{username}' });
console.log('/me/accounts ->', accounts.status, accounts.ok ? `${(accounts.j.data || []).length} páginas: ` + (accounts.j.data || []).map(p => p.name + (p.instagram_business_account ? ' (IG: @' + p.instagram_business_account.username + ')' : ' (sin IG)')).join(', ') : JSON.stringify(accounts.j.error));
