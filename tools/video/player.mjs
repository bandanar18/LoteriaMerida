// Video 2: cómo funciona FortunaBet para el jugador (DEMO), en formato celular.
import { join } from 'node:path';
import { api, env, go, login, record, root, scroll, scrollTop, sleep, tap, type } from './lib.mjs';

const btn = (p, name) => p.getByRole('button', { name });
const scenes = [
  {
    say: 'Bienvenido a FortunaBet. Así funciona la aplicación para el jugador, desde el celular. Es una demostración: los saldos y premios no tienen valor real y está prohibida su comercialización.',
    cap: 'FortunaBet para el jugador · Aplicación DEMO, sin valor real',
    run: async (p) => go(p, '/registro'),
  },
  {
    say: 'Para registrarte llenas tus datos: nombre, documento, fecha de nacimiento, teléfono y correo. Debes ser mayor de edad y aceptar que es una aplicación de demostración.',
    cap: 'Registro: tus datos, mayor de 18 y aceptar que es una aplicación DEMO',
    run: async (p) => {
      await scroll(p, 260, 1200);
      await type(p, p.locator('form input').nth(0), 'Valeria', 'nombre');
      await type(p, p.locator('form input').nth(1), 'Prueba', 'apellido');
      await scroll(p, 500, 1500);
      await scroll(p, 500, 1500);
    },
  },
  {
    say: 'Al registrarte recibes un bono de bienvenida de diez mil bolívares y diez dólares en USDT, como saldo de prueba para conocer todos los juegos.',
    cap: 'Bono de bienvenida DEMO: Bs. 10.000 y 10 USDT de saldo de prueba',
    run: async (p) => {
      await scrollTop(p);
      await scroll(p, 330, 1500);
    },
  },
  {
    say: 'Ya registrado, entras con tu correo y tu contraseña.',
    cap: 'Entrar con tu correo y contraseña',
    run: async (p) => {
      await go(p, '/login');
      await type(p, p.locator('#email'), 'prueba1@fortunabet.test', 'correo');
      await p.locator('#password').fill(env.SEED_TEST_PLAYERS_PASSWORD);
      await tap(p, btn(p, /^Entrar$/), 'Entrar');
      await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 }).catch(() => {});
      await go(p, '/');
    },
  },
  {
    say: 'En Jugar eliges el juego. Empezamos con Animalitos de Mérida: setenta animales y un sorteo cada hora. Arriba ves los últimos resultados y lo que paga el animal exacto.',
    cap: 'Jugar · Animalitos de Mérida: 70 animales, un sorteo por hora',
    run: async (p) => {
      await sleep(1500);
      await scroll(p, 380, 1500);
    },
  },
  {
    say: 'Eliges el sorteo y tocas los animales que quieres jugar. Por ejemplo: el Colibrí, el Venado y el Cunaguaro.',
    cap: 'Elige el sorteo y toca tus animalitos',
    run: async (p) => {
      await scroll(p, 300, 900);
      await tap(p, p.getByRole('button', { name: /^17 Colibr/ }), 'Colibrí');
      await tap(p, p.getByRole('button', { name: /^07 Venado/ }), 'Venado');
      await tap(p, p.getByRole('button', { name: /^24 Cunaguaro/ }), 'Cunaguaro');
    },
  },
  {
    say: 'Escoges el monto por jugada, y las agregas a tu ticket. Abajo siempre ves cuánto pagas y cuánto podrías ganar.',
    cap: 'Monto por jugada y agregar al ticket',
    run: async (p) => {
      await p.getByText('Monto por jugada').first().scrollIntoViewIfNeeded().catch(() => {});
      await sleep(600);
      await tap(p, btn(p, /^10$/), '10');
      await tap(p, btn(p, /^Agregar/), 'Agregar');
    },
  },
  {
    say: 'Revisas el ticket y lo compras. Recibes un comprobante con su código. Los tickets dicen DEMO, no canjeable.',
    cap: 'Comprar el ticket: comprobante con código · DEMO, NO CANJEABLE',
    run: async (p) => {
      await tap(p, btn(p, /Ver ticket/), 'Ver ticket');
      await sleep(1200);
      await tap(p, btn(p, /Comprar ticket/), 'Comprar ticket');
      await sleep(3500);
      await p.keyboard.press('Escape');
    },
  },
  {
    say: 'Frutas del Páramo funciona igual, con setenta frutas de Venezuela y tres sorteos al día.',
    cap: 'Frutas del Páramo: 70 frutas venezolanas, 3 sorteos al día',
    run: async (p) => {
      await scrollTop(p);
      await tap(p, btn(p, 'Frutas del Páramo'), 'Frutas');
      await sleep(1200);
      await scroll(p, 600, 1500);
    },
  },
  {
    say: 'En Triple Andino escribes un número del cero al novecientos noventa y nueve. Con la opción Las tres, tu número participa en triple, terminal y última cifra, y cobras el premio mayor que aciertes.',
    cap: 'Triple Andino: número de 000 a 999 · «Las 3» cobra el premio mayor',
    run: async (p) => {
      await scrollTop(p);
      await tap(p, btn(p, 'Triple Andino'), 'Triple');
      await sleep(1000);
      await p.getByText(/Escribe tu número/).first().scrollIntoViewIfNeeded().catch(() => {});
      for (const d of ['7', '1', '8']) await tap(p, btn(p, new RegExp(`^${d}$`)), d);
    },
  },
  {
    say: 'En Kino Teleférico eliges cinco, seis o siete números del uno al cuarenta. En cada sorteo salen siete: ganas si salen todos los que elegiste.',
    cap: 'Kino Teleférico: elige 5, 6 o 7 números del 01 al 40; salen 7',
    run: async (p) => {
      await scrollTop(p);
      await tap(p, btn(p, 'Kino Teleférico'), 'Kino');
      await sleep(1000);
      await p.getByText(/Elige 5 números/).first().scrollIntoViewIfNeeded().catch(() => {});
      for (const d of ['02', '07', '13', '22', '24']) await tap(p, btn(p, new RegExp(`^${d}$`)), d);
    },
  },
  {
    say: 'Y en Terminal Nevado juegas un número del cero al noventa y nueve. Con Las dos, ganas si sale tu número o el de al lado.',
    cap: 'Terminal Nevado: 00 a 99 · «Las 2»: tu número o el vecino',
    run: async (p) => {
      await scrollTop(p);
      await tap(p, btn(p, 'Terminal Nevado'), 'Terminal');
      await sleep(1000);
      await p.getByText(/Escribe tu número/).first().scrollIntoViewIfNeeded().catch(() => {});
      for (const d of ['1', '8']) await tap(p, btn(p, new RegExp(`^${d}$`)), d);
    },
  },
  {
    say: 'En Resultados ves los sorteos de cada juego. Cada resultado se puede verificar: el sistema publica antes una huella de la semilla y después la revela, así nadie puede elegir el resultado.',
    cap: 'Resultados verificables: nadie puede elegir el resultado',
    run: async (p) => {
      await go(p, '/resultados');
      await sleep(1500);
      await scroll(p, 450, 1500);
    },
  },
  {
    say: 'En Mis jugadas están todos tus tickets, con su estado: abierto, ganador o perdido, y el premio que cobraste.',
    cap: 'Mis jugadas: tus tickets, su estado y tus premios',
    run: async (p) => {
      await go(p, '/tickets');
      await sleep(2000);
      await scroll(p, 300, 1200);
    },
  },
  {
    say: 'Cumbre Futuros es un módulo de trading de demostración con Bitcoin, Ether y Solana. Los precios vienen de cinco exchanges reales. Antes de operar debes leer un aviso de riesgo y responder dos preguntas.',
    cap: 'Cumbre Futuros: BTC, ETH y SOL con precios de 5 exchanges · aviso de riesgo',
    run: async (p) => {
      await go(p, '/futuros');
      await sleep(2000);
      await scroll(p, 700, 1500);
      if (await tap(p, btn(p, /Leer el aviso de riesgo/), 'aviso')) {
        await sleep(800);
        await tap(p, p.getByText('La posición se liquida y pierdo el margen'), 'respuesta 1');
        await tap(p, p.getByText('De la mediana de varios exchanges externos'), 'respuesta 2');
        await tap(p, btn(p, /Entiendo los riesgos/), 'acepto');
      }
    },
  },
  {
    say: 'Pasas saldo de tu billetera a la de futuros, eliges el apalancamiento y el tamaño. Antes de confirmar ves el margen, la comisión y el precio de liquidación.',
    cap: 'Transferir, elegir tamaño y ver margen, comisión y liquidación antes de confirmar',
    run: async (p) => {
      await scrollTop(p);
      if (await tap(p, btn(p, /Transferir/), 'Transferir')) {
        await tap(p, btn(p, /^Máx.$/), 'Máx.');
        await tap(p, p.getByRole('button', { name: 'Transferir', exact: true }).last(), 'confirmar transferencia');
        await sleep(1500);
      }
      await p.getByPlaceholder('Valor de la posición en USDT').scrollIntoViewIfNeeded().catch(() => {});
      await type(p, p.getByPlaceholder('Valor de la posición en USDT'), '100', 'tamaño');
      await sleep(1200);
    },
  },
  {
    say: 'Confirmas la orden y tu posición aparece abajo, con la ganancia o pérdida en vivo. La cierras cuando quieras.',
    cap: 'Abrir la posición, verla en vivo y cerrarla',
    run: async (p) => {
      await tap(p, btn(p, /^Comprar \/ Long 0/), 'Long');
      await sleep(800);
      await tap(p, btn(p, /^Confirmar$/), 'Confirmar');
      await sleep(1500);
      await p.getByRole('button', { name: /^Posiciones/ }).scrollIntoViewIfNeeded().catch(() => {});
      await sleep(3000);
      if (await tap(p, btn(p, /^Cerrar$/), 'Cerrar')) {
        await sleep(800);
        await tap(p, btn(p, /^Cerrar 0/), 'Cerrar posición');
      }
    },
  },
  {
    say: 'En la billetera ves tus saldos en bolívares y en USDT, y tus movimientos. Los depósitos y retiros son simulados: en la demostración no se mueve dinero real.',
    cap: 'Billetera: saldos y movimientos · depósitos y retiros simulados',
    run: async (p) => {
      await go(p, '/billetera');
      await sleep(1500);
      await scroll(p, 500, 1500);
    },
  },
  {
    say: 'En tu cuenta verificas tu identidad, pones tus propios límites y puedes autoexcluirte por un tiempo. Juega con responsabilidad.',
    cap: 'Cuenta: verificación, límites y autoexclusión · juego responsable',
    run: async (p) => {
      await go(p, '/cuenta');
      await sleep(1500);
      await scroll(p, 500, 1500);
    },
  },
  {
    say: 'Eso es FortunaBet para el jugador. Recuerda: es una aplicación de demostración, sin valor real, y su comercialización está prohibida.',
    cap: 'FortunaBet · Aplicación DEMO: sin valor real · Prohibida su comercialización',
    run: async (p) => {
      await go(p, '/');
      await sleep(1000);
    },
  },
];

// Antes de grabar: la cuenta de prueba sin posiciones abiertas y con su USDT en la billetera principal,
// para que la escena de futuros pueda transferir y operar como la primera vez.
const tok = await login('prueba1@fortunabet.test', env.SEED_TEST_PLAYERS_PASSWORD);
const acc = (await api('GET', '/futures/account', tok)).j;
for (const p of acc?.positions ?? []) await api('POST', `/futures/positions/${p.id}/close`, tok, {});
const after = (await api('GET', '/futures/account', tok)).j;
if (Number(after?.available) > 0) await api('POST', '/futures/transfer', tok, { direction: 'OUT', amount: after.available });

await record({ name: 'jugador', scenes, mobile: true, out: join(root, 'videos', 'FortunaBet-jugador.mp4') });
