// Graba los dos videos. Si Futuros está oculto, lo muestra solo durante la grabación y lo deja como estaba.
// Uso: node run.mjs [admin|jugador|todos]
import { spawnSync } from 'node:child_process';
import { api, env, login } from './lib.mjs';

const which = process.argv[2] ?? 'todos';
const admin = await login(env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD);
const platform = (await api('GET', '/platform')).j;
const before = platform?.futuresEnabled;
console.log(`Futuros antes de grabar: ${before ? 'visible' : 'oculto'}`);
if (before === false) {
  const r = await api('PUT', '/admin/futures/availability', admin, { enabled: true });
  if (r.status >= 400) throw new Error(`No se pudo mostrar Futuros: ${r.j?.message}`);
}
let failed = false;
try {
  for (const [key, file] of [
    ['admin', 'admin.mjs'],
    ['jugador', 'player.mjs'],
  ]) {
    if (which !== 'todos' && which !== key) continue;
    const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
    if (r.status !== 0) failed = true;
  }
} finally {
  if (before === false) {
    // Reintenta: al terminar la grabación la API puede tardar en responder.
    for (let i = 1; i <= 5; i++) {
      try {
        const again = await login(env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD);
        const r = await api('PUT', '/admin/futures/availability', again, { enabled: false });
        if (r.status < 400) {
          console.log('Futuros vuelve a quedar oculto, como estaba.');
          break;
        }
      } catch (e) {
        if (i === 5) console.error(`No se pudo ocultar Futuros otra vez (${e.message}). Ocúltalo desde Configuración.`);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
process.exit(failed ? 1 : 0);
