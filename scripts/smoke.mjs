// Prueba end-to-end del API contra un servidor local en marcha.
//   node scripts/smoke.mjs          → flujo rápido (animalitos, pagos, KYC, tiempo real, deportes, ledger, auditoría)
//   node scripts/smoke.mjs --wait   → además espera ~8 min: sorteo automático por RNG y flujo con acta y 4 ojos
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const env = Object.fromEntries(
  readFileSync(new URL('../apps/api/.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✔' : '✘'} ${msg}`);
  if (!cond) failures++;
};

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

// Crea un sorteo extraordinario en el primer minuto libre a partir de 7 min (auto = resultado por RNG a la hora).
async function extraordinary(gameId, token, auto = false) {
  for (let m = 7; m < 15; m++) {
    const r = await call('POST', `/admin/lottery/games/${gameId}/extraordinary-draw`, { token, body: { minutesFromNow: m, auto } });
    if (r.status === 201) return r.data;
    if (r.data?.code !== 'CONFLICT') return r.data;
  }
}

const login = async (email, password) => (await call('POST', '/auth/login', { body: { email, password } })).data.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Socket.IO con o sin token; registra los eventos recibidos. */
function connectSocket(token) {
  const seen = new Set();
  const s = io(API.replace(/\/api\/v1$/, ''), { path: '/api/v1/socket.io', auth: token ? { token } : {}, transports: ['websocket'] });
  s.onAny((event) => seen.add(event));
  return new Promise((resolve, reject) => {
    s.once('hello', () => resolve({ got: (e) => seen.has(e), close: () => s.close() }));
    s.once('connect_error', reject);
  });
}

const player = await login(env.SEED_PLAYER_EMAIL, env.SEED_PLAYER_PASSWORD);
const admin = await login(env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD);
const supervisor = await login(env.SEED_SUPERVISOR_EMAIL, env.SEED_SUPERVISOR_PASSWORD);
const compliance = await login(env.SEED_COMPLIANCE_EMAIL, env.SEED_COMPLIANCE_PASSWORD);
const trader = await login(env.SEED_TRADER_EMAIL, env.SEED_TRADER_PASSWORD);
ok(player && admin && supervisor && compliance && trader, 'login de jugador, admin, supervisor, cumplimiento y trader');

const games = (await call('GET', '/lottery/games')).data;
ok(games.map((g) => g.code).join(',') === 'MER-05,MER-03,MER-01,MER-02,MER-04,MER-09,MER-06,MER-10,MER-08,MER-07', 'diez juegos activos (MER-01 a MER-10, sin el 06 de Futuros)');
const merida = games.find((g) => g.code === 'MER-05');
ok(
  merida?.symbols.length === 70 &&
    !merida.symbols.some((s) => s.number === '0') &&
    merida.symbols.find((s) => s.number === '17')?.name === 'Colibrí' &&
    merida.symbols.find((s) => s.number === '69')?.name === 'Mapache',
  'MER-05 v2.0: catálogo 00–69 (70 animales, 17 = Colibrí, 69 = Mapache)',
);
ok(
  merida?.schedule.map((x) => x.time).join(' ') === Array.from({ length: 12 }, (_, i) => `${String(9 + i).padStart(2, '0')}:00`).join(' '),
  'MER-05: 12 sorteos diarios, uno por hora de 09:00 a 20:00',
);
ok(merida?.modalities.find((m) => m.code === 'EXACT')?.factor_x100 === '5000', 'MER-05: Animal exacto paga 50×');
ok(
  merida?.modalities.find((m) => m.code === 'EXACT')?.status === 'ACTIVE' &&
    merida.modalities.filter((m) => m.status === 'PENDING_APPROVAL').length === 2,
  'MER-05: solo Animal exacto activo; Combinada y Múltiple pendientes',
);

const paramo = games.find((g) => g.code === 'MER-03');
ok(
  paramo?.symbols.length === 70 &&
    paramo.symbols.map((s) => s.number).join() === Array.from({ length: 70 }, (_, i) => String(i).padStart(2, '0')).join() &&
    paramo.symbols.slice(0, 6).map((s) => s.name).join() === 'Mora,Durazno,Uva,Fresa,Manzana,Pera',
  'MER-03: catálogo 00–69 (70 frutas, empieza por Mora, Durazno, Uva, Fresa, Manzana, Pera)',
);
ok(paramo?.schedule.map((x) => x.time).join(' ') === '09:30 13:30 18:30', 'MER-03: sorteos 09:30, 13:30 y 18:30');
ok(
  paramo?.modalities.map((m) => `${m.name}:${m.factor_x100}:${m.status}`).join() ===
    'Fruta exacta:4000:ACTIVE,Combinada:7000:PENDING_APPROVAL,Triple frutal:100000:PENDING_APPROVAL',
  'MER-03: Fruta exacta 40× activa; Combinada 70× y Triple frutal 1.000× pendientes',
);

const fut = (await call('GET', '/futures/contracts')).data;
ok(fut?.length === 3 && fut.map((c) => c.symbol).join() === 'BTCUSDT,ETHUSDT,SOLUSDT', `Cumbre Futuros: BTC, ETH y SOL (${fut?.filter((c) => c.feed_ok).length ?? 0} con feed válido)`);

const balanceOf = async (cur) => BigInt((await call('GET', '/me/balances', { token: player })).data.find((b) => b.currency === cur).cash);

// Sorteo extraordinario con venta abierta (los horarios regulares pueden estar cerrados según la hora).
const extra = await extraordinary(merida.id, supervisor, true);
ok(extra?.id && extra.auto_rng === true, 'supervisor crea sorteo automático (RNG) en Mérida');

const leon = merida.symbols.find((s) => s.name === 'León');
const tigre = merida.symbols.find((s) => s.name === 'Tigre');
const before = await balanceOf('VES');
const key = randomUUID();
const buy = () =>
  call('POST', '/lottery/tickets', {
    token: player,
    headers: { 'idempotency-key': key },
    body: { gameId: merida.id, currency: 'VES', plays: [{ drawId: extra.id, symbolId: leon.id, amount: '10' }, { drawId: extra.id, symbolId: tigre.id, amount: '5.50' }] },
  });
const [t1, t2] = await Promise.all([buy(), buy()]);
ok(t1.status === 201 && t1.data.total === '1550', `ticket vendido (total 15.50 Bs) → ${t1.data.code}`);
ok(t2.data?.id === t1.data.id, 'reintento concurrente con misma Idempotency-Key devuelve el mismo ticket');
ok((await balanceOf('VES')) === before - 1550n, 'saldo descontado una sola vez');

const over = await call('POST', '/lottery/tickets', {
  token: player,
  headers: { 'idempotency-key': randomUUID() },
  body: { gameId: merida.id, currency: 'VES', plays: [{ drawId: extra.id, symbolId: leon.id, amount: '5000' }] },
});
ok(over.data?.code === 'LIMIT_EXCEEDED', `límite por jugada rechazado (${over.data?.code})`);

// Cupo por animal: 600.000 Bs de pasivo / 50 = 12.000 Bs apostables por animal y sorteo.
// El tope por jugador (Bs. 5.000) se levanta durante esta prueba y se restaura después.
const limitsBefore = (await call('GET', `/admin/lottery/games/${merida.id}/config`, { token: admin })).data.limits.find((l) => l.currency === 'VES');
const bs = (minor) => (minor === null ? null : (Number(minor) / 100).toString());
const setVesLimits = (perPlayer) =>
  call('PUT', `/admin/lottery/games/${merida.id}/limits`, {
    token: supervisor,
    body: {
      currency: 'VES',
      minPlay: bs(limitsBefore.min_play),
      maxPlay: bs(limitsBefore.max_play),
      maxTicket: bs(limitsBefore.max_ticket),
      maxLiabilityPerSymbol: bs(limitsBefore.max_liability_per_symbol),
      maxPlayerPerDraw: perPlayer,
    },
  });
ok((await setVesLimits(null)).status === 200, 'configuración: operador quita el tope por jugador (temporal)');
// Fondear al jugador con un depósito aprobado para poder llegar al cupo.
const capDep = await call('POST', '/payments/deposits', {
  token: player,
  body: { method: 'TRANSFER', amount: '25000', bank: '0134 - Banesco', reference: `CAP${Date.now()}` },
});
await call('POST', `/admin/payments/deposits/${capDep.data.id}/approve`, { token: admin });
const capTickets = [];
let capHit = null;
for (let i = 0; i < 8 && !capHit; i++) {
  const r = await call('POST', '/lottery/tickets', {
    token: player,
    headers: { 'idempotency-key': randomUUID() },
    body: { gameId: merida.id, currency: 'VES', plays: [{ drawId: extra.id, symbolId: merida.symbols[5].id, amount: '2000' }] },
  });
  if (r.status === 201) capTickets.push(r.data.id);
  else capHit = r.data;
}
ok(capTickets.length === 6 && capHit?.code === 'LIMIT_EXCEEDED', `cupo por animal agotado tras 12.000 Bs (${capHit?.message})`);
for (const id of capTickets) await call('POST', `/lottery/tickets/${id}/cancel`, { token: player });
const freed = await call('POST', '/lottery/tickets', {
  token: player,
  headers: { 'idempotency-key': randomUUID() },
  body: { gameId: merida.id, currency: 'VES', plays: [{ drawId: extra.id, symbolId: merida.symbols[5].id, amount: '5' }] },
});
ok(freed.status === 201, 'anular tickets libera el cupo del animal');
await call('POST', `/lottery/tickets/${freed.data.id}/cancel`, { token: player });
const restored = await setVesLimits(bs(limitsBefore.max_player_per_draw));
ok(restored.status === 200 && restored.data.max_player_per_draw === limitsBefore.max_player_per_draw, 'configuración: tope por jugador restaurado');

const cancelled = await call('POST', `/lottery/tickets/${t1.data.id}/cancel`, { token: player });
ok(cancelled.data?.status === 'CANCELLED', 'jugador anula su ticket dentro de la ventana');
ok((await balanceOf('VES')) === before + 2_500_000n, 'anulaciones devuelven el saldo (saldo inicial + depósito de 25.000 Bs)');

// ── Animalitos de Mérida (MER-05) ──
const merExtra = await extraordinary(merida.id, supervisor);
const colibri = merida.symbols.find((s) => s.number === '17');
const merBuy = (plays) =>
  call('POST', '/lottery/tickets', { token: player, headers: { 'idempotency-key': randomUUID() }, body: { gameId: merida.id, currency: 'VES', plays } });
const combi = await merBuy([{ drawId: merExtra.id, symbolId: colibri.id, amount: '10', modality: 'COMBINADA' }]);
ok(combi.data?.code === 'MODALITY_NOT_ACTIVE', `MER-05: Combinada rechazada hasta su aprobación (${combi.data?.code})`);
const tooLow = await merBuy([{ drawId: merExtra.id, symbolId: colibri.id, amount: '4' }]);
ok(tooLow.data?.code === 'LIMIT_EXCEEDED', 'MER-05: mínimo de Bs. 5 por jugada');
const merT = await merBuy([{ drawId: merExtra.id, symbolId: colibri.id, amount: '10', modality: 'EXACT' }]);
ok(
  merT.status === 201 && merT.data.code.startsWith('DEMO-MER05-') && merT.data.is_demo && merT.data.rules_version === 'MER-05 v2.0-borrador',
  `MER-05: ticket demo con versión de reglas → ${merT.data?.code}`,
);
ok(merT.data?.potential_win === '50000' && merT.data.plays[0].modality === 'EXACT', 'MER-05: exacto 17 Colibrí con Bs. 10 → premio Bs. 500 (50×)');
// Tope por jugador y sorteo: Bs. 5.000 sumando todo lo que tiene abierto en ese sorteo.
const [a1s, a2s, a3s] = merida.symbols.slice(0, 3);
const capA = await merBuy([
  { drawId: merExtra.id, symbolId: a1s.id, amount: '2000' },
  { drawId: merExtra.id, symbolId: a2s.id, amount: '2000' },
]);
ok(capA.status === 201, 'MER-05: Bs. 4.010 abiertos en el sorteo (bajo el tope de Bs. 5.000 por jugador)');
const capB = await merBuy([{ drawId: merExtra.id, symbolId: a3s.id, amount: '1000' }]);
ok(capB.data?.code === 'LIMIT_EXCEEDED' && capB.data.details?.available === '99000', `MER-05: tope por jugador y sorteo (${capB.data?.message})`);
const avail = await call('GET', `/lottery/draws/${merExtra.id}/availability?currency=VES`);
ok(Array.isArray(avail.data?.soldOut) && avail.data.soldOut.length === 0, 'MER-05: disponibilidad pública sin animales agotados');
const badCur = await call('GET', `/lottery/draws/${merExtra.id}/availability?currency=EUR`);
ok(badCur.data?.code === 'INVALID_INPUT', 'MER-05: disponibilidad rechaza moneda inválida');
await call('POST', `/lottery/tickets/${capA.data.id}/cancel`, { token: player });
await call('POST', `/lottery/tickets/${merT.data.id}/cancel`, { token: player });
ok((await balanceOf('VES')) === before + 2_500_000n, 'MER-05: anulación devuelve el saldo');
// Sorteo manual sin jugadas: anularlo para no dejarlo pendiente de acta en el backoffice.
const merCancel = await call('POST', `/admin/lottery/draws/${merExtra.id}/cancel`, { token: supervisor, body: { reason: 'Sorteo de prueba automática' } });
ok(merCancel.data?.status === 'CANCELLED', 'MER-05: anular un sorteo lo registra como incidencia');

// ── Frutas del Páramo (MER-03) ──
const fruExtra = await extraordinary(paramo.id, supervisor, true);
const mora = paramo.symbols.find((s) => s.number === '00');
const fruBuy = (plays) =>
  call('POST', '/lottery/tickets', { token: player, headers: { 'idempotency-key': randomUUID() }, body: { gameId: paramo.id, currency: 'VES', plays } });
const fruCombi = await fruBuy([{ drawId: fruExtra.id, symbolId: mora.id, amount: '10', modality: 'COMBINADA' }]);
ok(fruCombi.data?.code === 'MODALITY_NOT_ACTIVE', 'MER-03: Combinada rechazada hasta su aprobación');
const fruT = await fruBuy([{ drawId: fruExtra.id, symbolId: mora.id, amount: '10' }]);
ok(
  fruT.status === 201 && fruT.data.code.startsWith('DEMO-MER03-') && fruT.data.rules_version === 'MER-03 v1.0-borrador' && fruT.data.potential_win === '40000',
  `MER-03: fruta exacta 00 Mora con Bs. 10 → premio Bs. 400 (40×) · ${fruT.data?.code}`,
);
const wrongGame = await fruBuy([{ drawId: merExtra.id, symbolId: mora.id, amount: '10' }]);
ok(wrongGame.status >= 400, `MER-03: no acepta jugadas en sorteos de otro juego (${wrongGame.data?.code})`);
await call('POST', `/lottery/tickets/${fruT.data.id}/cancel`, { token: player });
ok((await balanceOf('VES')) === before + 2_500_000n, 'MER-03: anulación devuelve el saldo');
const fruCancel = await call('POST', `/admin/lottery/draws/${fruExtra.id}/cancel`, { token: supervisor, body: { reason: 'Sorteo de prueba automática' } });
ok(fruCancel.data?.status === 'CANCELLED', 'MER-03: sorteo de prueba anulado');

// ── Simulador (recarga de prueba + sorteo privado al instante) ──
const simStatus = (await call('GET', '/simulation/status')).data;
ok(simStatus?.enabled === true, 'simulador activo en desarrollo');
const preSim = await balanceOf('VES');
const top = await call('POST', '/simulation/topup', { token: player, body: { currency: 'VES', amount: '1000' }, headers: { 'idempotency-key': randomUUID() } });
ok(top.status === 201 && (await balanceOf('VES')) === preSim + 100000n, 'simulador: recarga de prueba de Bs. 1.000 por el ledger');
const topBig = await call('POST', '/simulation/topup', { token: player, body: { currency: 'VES', amount: '20000' }, headers: { 'idempotency-key': randomUUID() } });
ok(topBig.data?.code === 'LIMIT_EXCEEDED', 'simulador: recarga sobre el máximo rechazada');
const simDraw = (await call('POST', `/simulation/games/${merida.id}/draw`, { token: player })).data;
const simAgain = (await call('POST', `/simulation/games/${merida.id}/draw`, { token: player })).data;
ok(simDraw?.status === 'OPEN' && simAgain?.id === simDraw.id, 'simulador: un sorteo privado abierto por jugador y juego');
const pubDraws = (await call('GET', `/lottery/games/${merida.id}/draws`)).data;
ok(!pubDraws.some((d) => d.id === simDraw.id), 'simulador: el sorteo privado no aparece en la lista pública');
const simEmpty = await call('POST', `/simulation/draws/${simDraw.id}/run`, { token: player });
ok(simEmpty.data?.code === 'INVALID_INPUT', 'simulador: no se sortea sin jugadas');
const realOpen = pubDraws.find((d) => d.status === 'OPEN' && new Date(d.close_at) > new Date());
if (realOpen) {
  const mixed = await merBuy([
    { drawId: simDraw.id, symbolId: colibri.id, amount: '5' },
    { drawId: realOpen.id, symbolId: colibri.id, amount: '5' },
  ]);
  ok(mixed.data?.code === 'INVALID_INPUT', 'simulador: un ticket no mezcla sorteo privado con sorteos reales');
}
// Cubrir los 70 animales con Bs. 5: gana exactamente uno y paga 50× → Bs. 250.
const allIn = await merBuy(merida.symbols.map((sym) => ({ drawId: simDraw.id, symbolId: sym.id, amount: '5' })));
ok(allIn.status === 201 && allIn.data.is_simulation === true, `simulador: ticket con los 70 animales → ${allIn.data?.code}`);
const simRun = await call('POST', `/simulation/draws/${simDraw.id}/run`, { token: player });
ok(
  simRun.status === 200 && simRun.data.plays.filter((p) => p.status === 'WON').length === 1 && simRun.data.won_amount.VES === '25000',
  `simulador: salió ${simRun.data?.result?.number} ${simRun.data?.result?.name}; una jugada gana Bs. 250 (50×)`,
);
ok((await balanceOf('VES')) === preSim + 100000n - 35000n + 25000n, 'simulador: saldo = recarga − Bs. 350 apostados + Bs. 250 de premio');
const simVerify = (await call('GET', `/lottery/draws/${simDraw.id}/verify`)).data;
ok(
  simVerify?.hashMatches === true && simVerify.symbols === 70 && simVerify.computedSymbol?.id === simRun.data.result.id,
  'simulador: el resultado es verificable con la semilla comprometida (mód. 70)',
);
const simTwice = await call('POST', `/simulation/draws/${simDraw.id}/run`, { token: player });
ok(simTwice.data?.code === 'INVALID_STATE', 'simulador: un sorteo no se puede volver a sortear');
const simNext = (await call('POST', `/simulation/games/${merida.id}/draw`, { token: player })).data;
ok(simNext?.id && simNext.id !== simDraw.id, 'simulador: «siguiente sorteo» crea uno nuevo');

// Ticket que se queda para el sorteo
const keep = await call('POST', '/lottery/tickets', {
  token: player,
  headers: { 'idempotency-key': randomUUID() },
  body: { gameId: merida.id, currency: 'USDT', plays: merida.symbols.slice(0, 3).map((s) => ({ drawId: extra.id, symbolId: s.id, amount: '1' })) },
});
ok(keep.status === 201, `ticket USDT con 3 animales → ${keep.data?.code}`);

// Pagos
const ref = `REF${Date.now()}`;
const dep = await call('POST', '/payments/deposits', { token: player, body: { method: 'PAGO_MOVIL', amount: '250', bank: '0105 - Mercantil', reference: ref, payerPhone: '04141234567' } });
ok(dep.status === 201, 'depósito Pago Móvil reportado');
const dup = await call('POST', '/payments/deposits', { token: player, body: { method: 'PAGO_MOVIL', amount: '250', bank: '0105 - Mercantil', reference: ref } });
ok(dup.data?.code === 'DUPLICATE_REFERENCE', 'misma referencia bancaria rechazada');
const forbidden = await call('POST', `/admin/payments/deposits/${dep.data.id}/approve`, { token: supervisor });
ok(forbidden.status === 403, 'operador de sorteos no puede aprobar depósitos');
const preDep = await balanceOf('VES');
await call('POST', `/admin/payments/deposits/${dep.data.id}/approve`, { token: admin });
ok((await balanceOf('VES')) === preDep + 25000n, 'admin aprueba depósito y se acredita 250 Bs');

const wd = await call('POST', '/payments/withdrawals', { token: player, body: { method: 'PAGO_MOVIL', amount: '100', bank: '0102', account: '04141234567' } });
ok(wd.status === 201, 'retiro solicitado (fondos bloqueados)');
await call('POST', `/admin/payments/withdrawals/${wd.data.id}/reject`, { token: admin, body: { reason: 'Prueba de rechazo' } });
ok((await balanceOf('VES')) === preDep + 25000n, 'retiro rechazado devuelve los fondos');
const tooMuch = await call('POST', '/payments/withdrawals', { token: player, body: { method: 'USDT', amount: '400', bank: 'TRC-20', account: 'TXXXXXXXXXXXX' } });
ok(tooMuch.data?.code === 'INSUFFICIENT_FUNDS', 'retiro mayor al saldo rechazado');

// ───────────── KYC ─────────────
console.log('\n— KYC');
const stamp = Date.now().toString().slice(-7);
const fresh = await call('POST', '/auth/register', {
  body: {
    email: `kyc${stamp}@loteria.test`,
    password: `Kyc.Prueba.${stamp}!`,
    documentType: 'V',
    documentNumber: `2${stamp}`,
    firstName: 'Prueba',
    lastName: 'Kyc',
    birthDate: '1995-03-10',
    phone: `0412${stamp}`,
    currency: 'VES',
    acceptDemoTerms: true,
  },
});
const kycPlayer = fresh.data?.accessToken;
ok(kycPlayer, 'jugador nuevo registrado (nivel 1)');
ok(fresh.data?.signupBonus?.VES === '1000000' && fresh.data?.signupBonus?.USDT === '10000000', 'bono de bienvenida DEMO: Bs. 10.000 y 10 USDT');
const freshBal = (await call('GET', '/me/balances', { token: kycPlayer })).data;
ok(freshBal.find((b) => b.currency === 'VES')?.cash === '1000000' && freshBal.find((b) => b.currency === 'USDT')?.cash === '10000000', 'el bono queda en el saldo del jugador');
const noDemo = await call('POST', '/auth/register', {
  body: {
    email: `nodemo${stamp}@loteria.test`,
    password: `Kyc.Prueba.${stamp}!`,
    documentType: 'V',
    documentNumber: `3${stamp}`,
    firstName: 'Sin',
    lastName: 'Demo',
    birthDate: '1995-03-10',
    phone: `0416${stamp}`,
    currency: 'VES',
  },
});
ok(noDemo.data?.code === 'INVALID_INPUT' && /DEMO/.test(noDemo.data.message), 'sin aceptar el aviso DEMO no se puede registrar');
const noWd = await call('POST', '/payments/withdrawals', { token: kycPlayer, body: { method: 'PAGO_MOVIL', amount: '10', bank: '0102', account: '04141234567' } });
ok(noWd.data?.code === 'KYC_REQUIRED', `nivel 1 no puede retirar (${noWd.data?.code})`);
const bigDep = await call('POST', '/payments/deposits', { token: kycPlayer, body: { method: 'TRANSFER', amount: '25000', bank: '0134', reference: `K${stamp}A` } });
ok(bigDep.data?.code === 'LIMIT_EXCEEDED', 'nivel 1: depósito sobre el límite diario rechazado');

const playerSocket = await connectSocket(kycPlayer);
const staffSocket = await connectSocket(compliance);

const jpeg = (seed) => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`foto-${seed}-${stamp}`)])], { type: 'image/jpeg' });
const kycForm = (docs) => {
  const f = new FormData();
  f.set('targetLevel', '2');
  for (const [type, blob] of Object.entries(docs)) f.set(type, blob, `${type}.jpg`);
  return f;
};
const upload = (form) => fetch(`${API}/me/kyc/requests`, { method: 'POST', headers: { authorization: `Bearer ${kycPlayer}` }, body: form }).then(async (r) => ({ status: r.status, data: await r.json() }));
const missing = await upload(kycForm({ ID_FRONT: jpeg('frente') }));
ok(missing.data?.code === 'INVALID_INPUT' && /Selfie/.test(missing.data.message), 'KYC sin selfie rechazado');
const fake = await upload(kycForm({ ID_FRONT: new Blob(['<html>no soy imagen</html>']), SELFIE: jpeg('selfie') }));
ok(fake.data?.code === 'INVALID_INPUT', 'archivo que no es JPG/PNG/PDF rechazado por su firma');
const frontBlob = jpeg('frente');
const sent = await upload(kycForm({ ID_FRONT: frontBlob, SELFIE: jpeg('selfie') }));
ok(sent.status === 201, 'solicitud de nivel 2 con documento y selfie enviada');
const again = await upload(kycForm({ ID_FRONT: jpeg('frente'), SELFIE: jpeg('selfie') }));
ok(again.data?.code === 'CONFLICT', 'no se permite una segunda solicitud mientras hay una en revisión');
ok((await call('GET', '/admin/kyc/requests', { token: supervisor })).status === 403, 'operador de sorteos no ve la cola KYC');

const queue = (await call('GET', '/admin/kyc/requests?status=PENDING', { token: compliance })).data;
const myReq = queue.find((r) => r.id === sent.data.id);
const front = myReq?.documents.find((d) => d.type === 'ID_FRONT');
const file = await fetch(`${API}/admin/kyc/documents/${front.id}/file`, { headers: { authorization: `Bearer ${compliance}` } });
const original = new Uint8Array(await frontBlob.arrayBuffer());
const downloaded = new Uint8Array(await file.arrayBuffer());
ok(file.ok && downloaded.length === original.length && downloaded.every((b, i) => b === original[i]), 'cumplimiento descarga el documento descifrado e íntegro');
ok((await call('POST', `/admin/kyc/requests/${sent.data.id}/review`, { token: trader, body: { decision: 'APPROVE' } })).status === 403, 'trader no puede aprobar KYC');
await call('POST', `/admin/kyc/requests/${sent.data.id}/review`, { token: compliance, body: { decision: 'APPROVE' } });
const kycNow = (await call('GET', '/me/kyc', { token: kycPlayer })).data;
ok(kycNow.level === 2, 'cumplimiento aprueba y el jugador sube a nivel 2');
await sleep(500);
ok(playerSocket.got('kyc'), 'tiempo real: el jugador recibe el aviso de KYC aprobado');
ok(staffSocket.got('queue'), 'tiempo real: el backoffice recibe el aviso de cola KYC');
playerSocket.close();
staffSocket.close();

// ───────────── Deportes ─────────────
console.log('\n— Deportes');
const catalogRes = await call('GET', '/sports/catalog');
if (catalogRes.status === 404) {
  console.log('  (deportes en pausa: SPORTS_ENABLED=false, se omite)');
  ok((await call('GET', '/admin/sports/events', { token: admin })).status === 404, 'deportes apagado: el backoffice tampoco lo expone');
} else {
const catalog = catalogRes.data;
const futve = catalog.competitions.find((c) => c.name === 'Liga FUTVE');
const lvbp = catalog.competitions.find((c) => c.name === 'LVBP');
const inOneHour = new Date(Date.now() + 3_600_000).toISOString();
const ev1 = await call('POST', '/admin/sports/events', {
  token: trader,
  body: {
    competitionId: futve.id,
    home: `Local ${stamp}`,
    away: `Visitante ${stamp}`,
    startsAt: inOneHour,
    markets: [
      { type: 'MATCH_RESULT', odds: { 1: '2.30', X: '3.10', 2: '3.05' } },
      { type: 'TOTAL_GOALS', line: '2.5', odds: { OVER: '2.05', UNDER: '1.75' } },
    ],
  },
});
ok(ev1.status === 201, 'trader crea partido de fútbol con 1X2 y total de goles');
const ev2 = await call('POST', '/admin/sports/events', {
  token: trader,
  body: { competitionId: lvbp.id, home: `Leones ${stamp}`, away: `Navegantes ${stamp}`, startsAt: inOneHour, markets: [{ type: 'MONEYLINE', odds: { 1: '1.85', 2: '1.95' } }] },
});
ok((await call('POST', '/admin/sports/events', { token: player, body: {} })).status === 403, 'el jugador no puede crear eventos');

const lobby = await connectSocket(null);
const eventById = async (id) => (await call('GET', '/sports/events')).data.find((e) => e.id === id);
const e1 = await eventById(ev1.data.id);
const e2 = await eventById(ev2.data.id);
const sel = (e, type, code) => {
  const m = e.markets.find((x) => x.type === type);
  return { market: m, sel: m.selections.find((s) => s.code === code) };
};
const home1 = sel(e1, 'MATCH_RESULT', '1');
const over25 = sel(e1, 'TOTAL_GOALS', 'OVER');
const draw1 = sel(e1, 'MATCH_RESULT', 'X');
const away2 = sel(e2, 'MONEYLINE', '2');
ok(over25.sel.name === 'Más de 2.5', `selecciones con nombre legible (${home1.sel.name} / ${over25.sel.name})`);

const bet = (legs, stake, extra = {}) =>
  call('POST', '/sports/bets', {
    token: player,
    headers: { 'idempotency-key': extra.key ?? randomUUID() },
    body: { type: legs.length > 1 ? 'PARLAY' : 'SINGLE', currency: 'VES', stake, oddsPolicy: extra.policy ?? 'NONE', legs },
  });
const preSports = await balanceOf('VES');
const keyA = randomUUID();
const [a1, a2] = await Promise.all([
  bet([{ selectionId: home1.sel.id, odds: '2.30' }], '100', { key: keyA }),
  bet([{ selectionId: home1.sel.id, odds: '2.30' }], '100', { key: keyA }),
]);
ok(a1.status === 201 && a1.data.potential_payout === '23000', `simple a 2.30 aceptada → ${a1.data.code} (pago potencial 230 Bs)`);
ok(a2.data?.id === a1.data.id, 'reintento con la misma Idempotency-Key devuelve el mismo cupón');

const moved = await call('POST', `/admin/sports/markets/${home1.market.id}/odds`, { token: trader, body: { odds: { [home1.sel.id]: '2.50' } } });
ok(moved.data?.changed === 1, `trader mueve la cuota del local a 2.50 (margen ${(moved.data?.marginBps / 100).toFixed(2)} %)`);
await sleep(500);
ok(lobby.got('odds'), 'tiempo real: el lobby recibe el cambio de cuota');
const stale = await bet([{ selectionId: home1.sel.id, odds: '2.30' }], '10');
ok(stale.data?.code === 'ODDS_CHANGED' && stale.data.details.changes[0].odds === '2.50', 'cuota vista desactualizada → ODDS_CHANGED con la nueva cuota');
const b = await bet([{ selectionId: home1.sel.id, odds: '2.30' }], '10', { policy: 'ACCEPT_HIGHER' });
ok(b.status === 201 && b.data.legs[0].odds_taken === '2.5000', 'política "aceptar si sube" toma la cuota nueva 2.50');
const c = await bet([{ selectionId: over25.sel.id, odds: '2.05' }], '20');
ok(c.status === 201, 'simple a Más de 2.5 goles');
const d = await bet([{ selectionId: home1.sel.id, odds: '2.50' }, { selectionId: away2.sel.id, odds: '1.95' }], '10');
ok(d.status === 201 && d.data.total_odds === '4.8750' && d.data.potential_payout === '4875', 'combinada fútbol + béisbol: cuota 4.875, pago 48,75 Bs');
const same = await bet([{ selectionId: home1.sel.id, odds: '2.50' }, { selectionId: over25.sel.id, odds: '2.05' }], '10');
ok(same.data?.code === 'INVALID_INPUT', 'combinada con dos selecciones del mismo partido rechazada');
const tooBig = await bet([{ selectionId: home1.sel.id, odds: '2.50' }], '6000');
ok(tooBig.data?.code === 'LIMIT_EXCEEDED', 'monto sobre el máximo por apuesta rechazado');

await call('POST', `/admin/sports/events/${ev1.data.id}/markets-status`, { token: trader, body: { status: 'SUSPENDED' } });
const susp = await bet([{ selectionId: draw1.sel.id, odds: '3.10' }], '10');
ok(susp.data?.code === 'MARKET_SUSPENDED', 'mercados suspendidos no aceptan apuestas');
await call('POST', `/admin/sports/events/${ev1.data.id}/markets-status`, { token: trader, body: { status: 'OPEN' } });
await call('POST', `/admin/sports/events/${ev1.data.id}/live`, { token: trader });
const t0 = Date.now();
const f = await bet([{ selectionId: draw1.sel.id, odds: '3.10' }], '10', { policy: 'ACCEPT_ANY' });
ok(f.status === 201 && f.data.live && Date.now() - t0 >= catalog.liveBetDelayMs, `apuesta en vivo aceptada tras el retardo de ${catalog.liveBetDelayMs / 1000} s`);
await call('POST', `/admin/sports/events/${ev1.data.id}/score`, { token: trader, body: { home: 2, away: 1 } });

await call('POST', `/admin/sports/events/${ev1.data.id}/propose-result`, { token: admin, body: { home: 2, away: 1, evidence: 'Acta del partido (prueba)' } });
const selfConfirm = await call('POST', `/admin/sports/events/${ev1.data.id}/confirm-result`, { token: admin });
ok(selfConfirm.data?.code === 'FOUR_EYES_REQUIRED', 'quien carga el resultado deportivo no puede confirmarlo');
const confirmed = await call('POST', `/admin/sports/events/${ev1.data.id}/confirm-result`, { token: trader });
ok(confirmed.data?.slipsSettled === 4, `trader confirma 2-1 y se liquidan ${confirmed.data?.slipsSettled} cupones (la combinada sigue abierta)`);
const voided = await call('POST', `/admin/sports/markets/${away2.market.id}/void`, { token: trader, body: { reason: 'Juego no oficial (prueba)' } });
ok(voided.data?.slipsAffected === 1, 'mercado de béisbol anulado: la combinada se paga con esa selección a 1.00');
const myBets = (await call('GET', '/sports/bets', { token: player })).data;
const status = (id) => myBets.find((x) => x.id === id);
ok(
  status(a1.data.id).status === 'WON' && status(b.data.id).status === 'WON' && status(c.data.id).status === 'WON' &&
    status(f.data.id).status === 'LOST' && status(d.data.id).status === 'WON' && status(d.data.id).payout === '2500',
  'estados finales: simples ganadas, empate en vivo perdido, combinada ganada por 25 Bs',
);
// El partido de béisbol de prueba queda sin resultado: cancelarlo para no dejarlo en el backoffice.
await call('POST', `/admin/sports/events/${ev2.data.id}/cancel`, { token: trader, body: { reason: 'Evento de prueba automática' } });
ok((await balanceOf('VES')) === preSports + 17100n, 'saldo: −150 Bs apostados + 321 Bs en premios = +171 Bs');
lobby.close();
}

const recon = (await call('GET', '/admin/ledger/reconcile', { token: admin })).data;
ok(recon.ok, 'ledger cuadrado (Σ D = Σ C, saldos = suma de asientos)');
const chain = (await call('GET', '/admin/audit/verify', { token: admin })).data;
ok(chain.ok, `cadena de auditoría íntegra (${chain.checked} registros)`);

if (process.argv.includes('--wait')) {
  const merDraw = await extraordinary(merida.id, supervisor);
  const merCol = merida.symbols.find((s) => s.number === '17');
  const mt = await call('POST', '/lottery/tickets', {
    token: player,
    headers: { 'idempotency-key': randomUUID() },
    body: { gameId: merida.id, currency: 'VES', plays: [{ drawId: merDraw.id, symbolId: merCol.id, amount: '10' }] },
  });
  ok(mt.status === 201, 'MER-05: ticket para el flujo con acta');

  console.log('… esperando a que pasen los sorteos extraordinarios');
  const latest = Math.max(new Date(extra.draw_at).getTime(), new Date(merDraw.draw_at).getTime());
  await sleep(Math.max(latest - Date.now(), 0) + 30_000);
  const draws = (await call('GET', `/lottery/games/${merida.id}/draws`)).data;
  const done = draws.find((d) => d.id === extra.id);
  ok(done?.status === 'SETTLED', `sorteo automático liquidado sin intervención: salió ${done?.result_number} ${done?.result_name}`);
  const v = (await call('GET', `/lottery/draws/${extra.id}/verify`)).data;
  ok(v.hashMatches && v.resultMatches && v.symbols === 70, 'verificación provably fair coincide con el resultado (mód. 70)');
  const kt = (await call('GET', `/lottery/tickets/${keep.data.code}`, { token: player })).data;
  ok(['WON', 'LOST'].includes(kt.status), `ticket USDT liquidado → ${kt.status} (premio ${kt.total_win})`);

  // MER-05: preliminar público → sin acta no hay oficial → acta → 4 ojos → oficial y premio.
  const preMer = await balanceOf('VES');
  await call('POST', `/admin/lottery/draws/${merDraw.id}/propose-result`, { token: admin, body: { symbolId: merCol.id, evidence: 'Transmisión del sorteo' } });
  const pub = (await call('GET', `/lottery/games/${merida.id}/draws`)).data.find((d) => d.id === merDraw.id);
  ok(pub.preliminary_number === '17' && pub.result_number === null, 'MER-05: resultado preliminar publicado, aún no oficial');
  const noRec = await call('POST', `/admin/lottery/draws/${merDraw.id}/confirm-result`, { token: supervisor });
  ok(noRec.data?.code === 'RECORD_REQUIRED', 'MER-05: no se confirma sin acta');
  const fd = new FormData();
  fd.append('recordNumber', 'ACTA-PRUEBA-1');
  fd.append('executor', 'Ejecutor de prueba');
  fd.append('inspector', 'Fiscal de prueba');
  fd.append('file', new Blob([Buffer.from('%PDF-1.4\n% acta de prueba\n')], { type: 'application/pdf' }), 'acta.pdf');
  const recRes = await fetch(`${API}/admin/lottery/draws/${merDraw.id}/record`, { method: 'POST', headers: { authorization: `Bearer ${supervisor}` }, body: fd });
  ok(recRes.status === 201, 'MER-05: acta registrada con archivo cifrado');
  const fileRes = await fetch(`${API}/admin/lottery/draws/${merDraw.id}/record/file`, { headers: { authorization: `Bearer ${admin}` } });
  ok(fileRes.status === 200 && (await fileRes.text()).startsWith('%PDF'), 'MER-05: el acta se descifra íntegra');
  const self = await call('POST', `/admin/lottery/draws/${merDraw.id}/confirm-result`, { token: admin });
  ok(self.data?.code === 'FOUR_EYES_REQUIRED', 'quien carga el resultado no puede confirmarlo');
  await call('POST', `/admin/lottery/draws/${merDraw.id}/confirm-result`, { token: supervisor });
  ok((await balanceOf('VES')) === preMer + 50000n, 'MER-05: resultado oficial con acta y premio 50× acreditado (500 Bs)');

  const recon2 = (await call('GET', '/admin/ledger/reconcile', { token: admin })).data;
  ok(recon2.ok, 'ledger cuadrado tras liquidaciones');
}

console.log(failures ? `\n${failures} verificación(es) fallaron` : '\nTodo OK');
process.exit(failures ? 1 : 0);
