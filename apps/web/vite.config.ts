import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ command }) => {
  // Accesos rápidos de prueba en la pantalla de entrar: SOLO en el servidor de desarrollo (`vite dev`).
  // Se leen de apps/api/.env (SEED_*), así no se duplican credenciales; `vite build` nunca las incluye.
  const seed = command === 'serve' ? loadEnv('development', '../api', 'SEED_') : {};
  const devLogins =
    command === 'serve'
      ? [
          { label: 'Administrador', email: seed.SEED_ADMIN_EMAIL, password: seed.SEED_ADMIN_PASSWORD },
          { label: 'Jugador', email: seed.SEED_PLAYER_EMAIL, password: seed.SEED_PLAYER_PASSWORD },
          ...[1, 2, 3, 4, 5].map((n) => ({ label: `Prueba ${n}`, email: `prueba${n}@fortunabet.test`, password: seed.SEED_TEST_PLAYERS_PASSWORD })),
        ].filter((l) => l.email && l.password)
      : [];

  return {
    plugins: [react(), tailwindcss()],
    define: { __DEV_LOGINS__: JSON.stringify(devLogins) },
    server: {
      port: 5173,
      proxy: { '/api': { target: 'http://localhost:3000', ws: true } },
    },
  };
});
