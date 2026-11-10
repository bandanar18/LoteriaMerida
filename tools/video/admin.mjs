// Video 1: cómo funciona el administrador de FortunaBet (DEMO).
import { join } from 'node:path';
import { env, go, here, record, root, scroll, scrollTop, sleep, tap, type } from './lib.mjs';

const scenes = [
  {
    say: 'Bienvenido a FortunaBet. Este es un recorrido por el panel de administración. Recuerda: es una aplicación de demostración, sin valor real, y está prohibida su comercialización.',
    cap: 'FortunaBet · Recorrido por el administrador (aplicación DEMO, sin valor real)',
    run: async (p) => go(p, '/login'),
  },
  {
    say: 'Para entrar usamos una cuenta del personal. Cada rol ve solo lo que le corresponde: administrador, operador de sorteos, cajero, cumplimiento y auditor.',
    cap: 'Entrar con una cuenta del personal (cada rol ve solo lo suyo)',
    run: async (p) => {
      await type(p, p.locator('#email'), env.SEED_ADMIN_EMAIL, 'correo');
      await p.locator('#password').fill(env.SEED_ADMIN_PASSWORD);
      await tap(p, p.getByRole('button', { name: 'Entrar', exact: true }), 'Entrar');
      await p.waitForURL(/\/admin/, { timeout: 10000 }).catch(() => {});
      await sleep(1500);
    },
  },
  {
    say: 'El resumen de operación muestra los jugadores registrados, los tickets vendidos hoy, y dos controles de integridad: el ledger contable cuadrado y la cadena de auditoría íntegra.',
    cap: 'Resumen: jugadores, tickets del día, ledger cuadrado y auditoría íntegra',
    run: async (p) => {
      await sleep(1500);
      await scroll(p, 260);
    },
  },
  {
    say: 'Más abajo, cada juego del día: Animalitos, Frutas del Páramo, Triple Andino, Kino Teleférico y Terminal Nevado, con sus ventas, su ganancia, los tickets y el próximo sorteo.',
    cap: 'Juegos de hoy: ventas, ganancia, tickets y próximo sorteo de cada juego',
    run: async (p) => {
      await scroll(p, 380, 1500);
      await scroll(p, 360, 1500);
    },
  },
  {
    say: 'En Sorteos se manejan los sorteos de cada día. Al elegir uno se ve su exposición por número, el compromiso de la semilla del generador aleatorio, y el resultado oficial, que exige acta y la confirmación de una segunda persona.',
    cap: 'Sorteos: exposición, semilla comprometida y resultado con acta y cuatro ojos',
    run: async (p) => {
      await go(p, '/admin/sorteos');
      await sleep(1200);
      const row = p.locator('main button, main tr').filter({ hasText: /p\. m\.|a\. m\./ });
      await tap(p, row.nth(1), 'un sorteo');
      await sleep(1500);
      await scroll(p, 300, 1500);
    },
  },
  {
    say: 'Con el botón de sorteo extraordinario se programa un sorteo adicional. Si es automático, el resultado lo pone el generador aleatorio verificable a la hora indicada, y nadie puede elegirlo.',
    cap: 'Sorteo extraordinario: el resultado sale del RNG verificable, nadie lo elige',
    run: async (p) => {
      await scrollTop(p);
      await tap(p, p.getByRole('button', { name: /Sorteo extraordinario/ }), 'Sorteo extraordinario');
      await sleep(3500);
      await p.keyboard.press('Escape');
    },
  },
  {
    say: 'Riesgo calcula, con la probabilidad real de cada juego, la ganancia esperada, el peor caso y cuánto del tope de pago se ha usado en cada sorteo. Así se controla el riesgo sin tocar los resultados.',
    cap: 'Riesgo: ganancia esperada, peor caso y uso del tope de pago (sin tocar resultados)',
    run: async (p) => {
      await go(p, '/admin/riesgo');
      await sleep(1500);
      await scroll(p, 350, 1500);
      await scroll(p, 350, 1500);
    },
  },
  {
    say: 'Mercado es el tablero de análisis: la ganancia acumulada en velas, el margen de cada sorteo, la frecuencia de cada animal frente a lo esperado, una prueba estadística de que el azar es justo, y el libro con todos los tickets jugados.',
    cap: 'Mercado: ganancia, margen por sorteo, frecuencias, prueba de azar y libro de tickets',
    run: async (p) => {
      await go(p, '/admin/mercado');
      await sleep(2000);
      await scroll(p, 420, 1600);
      await scroll(p, 500, 1600);
      await scroll(p, 600, 1600);
    },
  },
  {
    say: 'En Configuración el administrador activa o desactiva cada juego y el módulo de Futuros, programa sorteos automáticos, cambia los montos mínimos y máximos de apuesta, y edita los horarios.',
    cap: 'Configuración: activar juegos y Futuros, sorteos automáticos, montos y horarios',
    run: async (p) => {
      await go(p, '/admin/configuracion');
      await sleep(1500);
      await scroll(p, 450, 1600);
      await scroll(p, 500, 1600);
    },
  },
  {
    say: 'Al final está el reseteo del historial: saca de las estadísticas los sorteos de un rango de fecha y hora, de un juego o de todos. No borra dinero ni registros, queda en auditoría y se puede restaurar.',
    cap: 'Reseteo de historial por rango: no borra dinero ni registros y se puede restaurar',
    run: async (p) => {
      await p.getByText('Resetear historial de sorteos').first().scrollIntoViewIfNeeded().catch(() => {});
      await sleep(2500);
      await scroll(p, 300, 1500);
    },
  },
  {
    say: 'Cumbre Futuros es el panel de los contratos perpetuos de Bitcoin, Ether y Solana. Muestra el resultado de la casa del día, la salud del precio que llega de cinco exchanges, la exposición neta, y las posiciones y liquidaciones. El administrador puede pausar un contrato o ajustar su configuración.',
    cap: 'Cumbre Futuros: resultado de la casa, feed de 5 exchanges, exposición y liquidaciones',
    run: async (p) => {
      await go(p, '/admin/futuros');
      await sleep(2000);
      await scroll(p, 420, 1600);
      await scroll(p, 500, 1600);
    },
  },
  {
    say: 'En Pagos el cajero revisa los depósitos y los retiros. En esta demostración no se mueve dinero real: todo es saldo de prueba.',
    cap: 'Pagos: depósitos y retiros (en la DEMO no hay dinero real)',
    run: async (p) => {
      await go(p, '/admin/pagos');
      await sleep(2500);
    },
  },
  {
    say: 'Verificación KYC es donde cumplimiento revisa los documentos de identidad de los jugadores. Los archivos se guardan cifrados.',
    cap: 'Verificación KYC: documentos de identidad, guardados cifrados',
    run: async (p) => {
      await go(p, '/admin/kyc');
      await sleep(2500);
    },
  },
  {
    say: 'En Jugadores se busca a cualquier jugador y se ven sus saldos, su nivel de verificación y su estado.',
    cap: 'Jugadores: búsqueda, saldos, nivel de verificación y estado',
    run: async (p) => {
      await go(p, '/admin/jugadores');
      await sleep(2500);
    },
  },
  {
    say: 'Y en Auditoría queda cada acción importante, con quién la hizo y cuándo, en una cadena encadenada por hash que permite detectar cualquier alteración.',
    cap: 'Auditoría: cada acción, quién y cuándo, en una cadena encadenada por hash',
    run: async (p) => {
      await go(p, '/admin/auditoria');
      await sleep(2000);
      await scroll(p, 300, 1500);
    },
  },
  {
    say: 'Eso es todo el panel de administración de FortunaBet. Recuerda que es una aplicación de demostración: sin valor real y con su comercialización prohibida.',
    cap: 'FortunaBet · Aplicación DEMO: sin valor real · Prohibida su comercialización',
    run: async (p) => {
      await go(p, '/admin');
      await sleep(1500);
    },
  },
];

await record({ name: 'administrador', scenes, mobile: false, out: join(root, 'videos', 'FortunaBet-administrador.mp4') });
void here;
