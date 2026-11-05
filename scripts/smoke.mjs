// Prueba end-to-end del API contra un servidor local en marcha.
//   node scripts/smoke.mjs          → flujo rápido (animalitos, pagos, KYC, tiempo real, deportes, ledger, auditoría)
//   node scripts/smoke.mjs --wait   → además crea sorteos extraordinarios y espera ~6 min a que se sorteen y liquiden
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

// Crea un sorteo extraordinario en el primer minuto libre a partir de 7 min.
async function extraordinary(gameId, token) {
  for (let m = 7; m < 15; m++) {
    const r = await call('POST', `/admin/lottery/games/${gameId}/extraordinary-draw`, { token, body: { minutesFromNow: m } });
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
const tepuy = games.find((g) => g.name.includes('Tepuy'));
const sabana = games.find((g) => g.name.includes('Sabana'));
ok(tepuy?.symbols.length === 38, 'juego Tepuy con 38 animales');

const balanceOf = async (cur) => BigInt((await call('GET', '/me/balances', { token: player })).data.find((b) => b.currency === cur).cash);

// Sorteo extraordinario con venta abierta (los horarios regulares pueden estar cerrados según la hora).
const extra = await extraordinary(tepuy.id, supervisor);
ok(extra?.id, 'supervisor crea sorteo extraordinario en Tepuy');

const leon = tepuy.symbols.find((s) => s.name === 'León');
const tigre = tepuy.symbols.find((s) => s.name === 'Tigre');
const before = await balanceOf('VES');
const key = randomUUID();
const buy = () =>
  call('POST', '/lottery/tickets', {
    token: player,
    headers: { 'idempotency-key': key },
    body: { gameId: tepuy.id, currency: 'VES', plays: [{ drawId: extra.id, symbolId: leon.id, amount: '10' }, { drawId: extra.id, symbolId: tigre.id, amount: '5.50' }] },
  });
const [t1, t2] = await Promise.all([buy(), buy()]);
ok(t1.status === 201 && t1.data.total === '1550', `ticket vendido (total 15.50 Bs) → ${t1.data.code}`);
ok(t2.data?.id === t1.data.id, 'reintento concurrente con misma Idempotency-Key devuelve el mismo ticket');
ok((await balanceOf('VES')) === before - 1550n, 'saldo descontado una sola vez');

const over = await call('POST', '/lottery/tickets', {
  token: player,
  headers: { 'idempotency-key': randomUUID() },
  body: { gameId: tepuy.id, currency: 'VES', plays: [{ drawId: extra.id, symbolId: leon.id, amount: '5000' }] },
});
ok(over.data?.code === 'LIMIT_EXCEEDED', `límite por jugada rechazado (${over.data?.code})`);

// Cupo por animal: 600.000 Bs de pasivo / 30 = 20.000 Bs apostables por animal y sorteo.
// Fondear al jugador con un depósito aprobado para poder llegar al cupo.
const capDep = await call('POST', '/payments/deposits', {
  token: player,
  body: { method: 'TRANSFER', amount: '25000', bank: '0134 - Banesco', reference: `CAP${Date.now()}` },
});
await call('POST', `/admin/payments/deposits/${capDep.data.id}/approve`, { token: admin });
const capTickets = [];
let capHit = null;
for (let i = 0; i < 11 && !capHit; i++) {
  const r = await call('POST', '/lottery/tickets', {
    token: player,
    headers: { 'idempotency-key': randomUUID() },
    body: { gameId: tepuy.id, currency: 'VES', plays: [{ drawId: extra.id, symbolId: tepuy.symbols[5].id, amount: '2000' }] },
  });
  if (r.status === 201) capTickets.push(r.data.id);
  else capHit = r.data;
}
ok(capTickets.length === 10 && capHit?.code === 'LIMIT_EXCEEDED', `cupo por animal agotado tras 20.000 Bs (${capHit?.message})`);
for (const id of capTickets) await call('POST', `/lottery/tickets/${id}/cancel`, { token: player });
const freed = await call('POST', '/lottery/tickets', {
  token: player,
  headers: { 'idempotency-key': randomUUID() },
  body: { gameId: tepuy.id, currency: 'VES', plays: [{ drawId: extra.id, symbolId: tepuy.symbols[5].id, amount: '1' }] },
});
ok(freed.status === 201, 'anular tickets libera el cupo del animal');
await call('POST', `/lottery/tickets/${freed.data.id}/cancel`, { token: player });

const cancelled = await call('POST', `/lottery/tickets/${t1.data.id}/cancel`, { token: player });
ok(cancelled.data?.status === 'CANCELLED', 'jugador anula su ticket dentro de la ventana');
ok((await balanceOf('VES')) === before + 2_500_000n, 'anulaciones devuelven el saldo (saldo inicial + depósito de 25.000 Bs)');

// Ticket que se queda para el sorteo
const keep = await call('POST', '/lottery/tickets', {
  token: player,
  headers: { 'idempotency-key': randomUUID() },
  body: { gameId: tepuy.id, currency: 'USDT', plays: tepuy.symbols.slice(0, 3).map((s) => ({ drawId: extra.id, symbolId: s.id, amount: '1' })) },
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
  },
});
const kycPlayer = fresh.data?.accessToken;
ok(kycPlayer, 'jugador nuevo registrado (nivel 1)');
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
const catalog = (await call('GET', '/sports/catalog')).data;
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

const recon = (await call('GET', '/admin/ledger/reconcile', { token: admin })).data;
ok(recon.ok, 'ledger cuadrado (Σ D = Σ C, saldos = suma de asientos)');
const chain = (await call('GET', '/admin/audit/verify', { token: admin })).data;
ok(chain.ok, `cadena de auditoría íntegra (${chain.checked} registros)`);

if (process.argv.includes('--wait')) {
  const manual = await extraordinary(sabana.id, supervisor);
  const toro = sabana.symbols.find((s) => s.name === 'Toro');
  const m = await call('POST', '/lottery/tickets', {
    token: player,
    headers: { 'idempotency-key': randomUUID() },
    body: { gameId: sabana.id, currency: 'VES', plays: [{ drawId: manual.id, symbolId: toro.id, amount: '20' }] },
  });
  ok(m.status === 201, 'ticket en sorteo de resultado manual');
  const preWin = await balanceOf('VES');

  console.log('… esperando a que pasen los sorteos extraordinarios');
  const latest = Math.max(new Date(extra.draw_at).getTime(), new Date(manual.draw_at).getTime());
  await sleep(Math.max(latest - Date.now(), 0) + 30_000);
  const draws = (await call('GET', `/lottery/games/${tepuy.id}/draws`)).data;
  const done = draws.find((d) => d.id === extra.id);
  ok(done.status === 'SETTLED', `sorteo RNG liquidado: salió ${done.result_number} ${done.result_name}`);
  const v = (await call('GET', `/lottery/draws/${extra.id}/verify`)).data;
  ok(v.hashMatches && v.resultMatches, 'verificación provably fair coincide con el resultado');
  const kt = (await call('GET', `/lottery/tickets/${keep.data.code}`, { token: player })).data;
  ok(['WON', 'LOST'].includes(kt.status), `ticket USDT liquidado → ${kt.status} (premio ${kt.total_win})`);

  await call('POST', `/admin/lottery/draws/${manual.id}/propose-result`, { token: admin, body: { symbolId: toro.id, evidence: 'Acta de prueba #1' } });
  const self = await call('POST', `/admin/lottery/draws/${manual.id}/confirm-result`, { token: admin });
  ok(self.data?.code === 'FOUR_EYES_REQUIRED', 'quien carga el resultado no puede confirmarlo');
  await call('POST', `/admin/lottery/draws/${manual.id}/confirm-result`, { token: supervisor });
  ok((await balanceOf('VES')) === preWin + 60000n, 'resultado manual confirmado por otro usuario y premio 30× acreditado (600 Bs)');

  const recon2 = (await call('GET', '/admin/ledger/reconcile', { token: admin })).data;
  ok(recon2.ok, 'ledger cuadrado tras liquidaciones');
}

console.log(failures ? `\n${failures} verificación(es) fallaron` : '\nTodo OK');
process.exit(failures ? 1 : 0);
