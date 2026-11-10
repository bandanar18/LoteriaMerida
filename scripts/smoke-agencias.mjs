// Prueba end-to-end del Programa de Agencias Virtuales contra el API local.
//   node scripts/smoke-agencias.mjs          → activación, código, referidos, comisiones, reversos, tasas, suspensión
//   node scripts/smoke-agencias.mjs --wait   → además espera ~8 min a que un sorteo RNG se liquide y prueba la
//                                              liberación y el paso a saldo de juego
import { readFileSync } from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';

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
const login = async (email, password) => (await call('POST', '/auth/login', { body: { email, password } })).data.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function extraordinary(gameId, token, auto = false) {
  for (let m = 7; m < 20; m++) {
    const r = await call('POST', `/admin/lottery/games/${gameId}/extraordinary-draw`, { token, body: { minutesFromNow: m, auto } });
    if (r.status === 201) return r.data;
    if (r.data?.code !== 'CONFLICT') return r.data;
  }
}

/** Registra un jugador nuevo con datos aleatorios válidos. */
async function register(first, last, referralCode) {
  const doc = String(randomInt(10_000_000, 30_000_000));
  const res = await call('POST', '/auth/register', {
    body: {
      firstName: first,
      lastName: last,
      documentType: 'V',
      documentNumber: doc,
      birthDate: '1990-05-10',
      phone: `0414${randomInt(1_000_000, 9_999_999)}`,
      email: `agencia.${randomUUID().slice(0, 8)}@prueba.test`,
      password: 'Prueba.Agencia.2026',
      currency: 'VES',
      acceptDemoTerms: true,
      ...(referralCode !== undefined ? { referralCode } : {}),
    },
  });
  return res;
}

const admin = await login(env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD);
const supervisor = await login(env.SEED_SUPERVISOR_EMAIL, env.SEED_SUPERVISOR_PASSWORD);
ok(admin && supervisor, 'login de admin y supervisor');

const games = (await call('GET', '/lottery/games')).data;
const merida = games.find((g) => g.code === 'MER-05');
const [s1, s2, s3] = merida.symbols;

// ── Activación de agencia ──
const agentReg = await register('Rosa', 'Andrade');
ok(agentReg.status === 201, 'registro del futuro dueño de la agencia');
const agentTok = agentReg.data.accessToken;
const noAgent = await call('GET', '/agent/me', { token: agentTok });
ok(noAgent.data?.code === 'AGENT_NOT_FOUND', 'sin agencia: /agent/me responde AGENT_NOT_FOUND');
const noTerms = await call('POST', '/agent', { token: agentTok, body: { displayName: 'Agencia Los Andes', acceptTerms: false } });
ok(noTerms.data?.code === 'INVALID_INPUT', 'activar exige aceptar los términos');
const act = await call('POST', '/agent', { token: agentTok, body: { displayName: 'Agencia Los Andes', acceptTerms: true } });
ok(act.status === 201 && /^FB-[0-9A-HJKMNP-TV-Z]{6}$/.test(act.data?.code ?? ''), `agencia activada con código ${act.data?.code}`);
const again = await call('POST', '/agent', { token: agentTok, body: { displayName: 'Otra', acceptTerms: true } });
ok(again.data?.code === 'AGENT_ALREADY_EXISTS', 'una agencia por persona');
const code = act.data.code;
const rawCode = code.replace('-', '');

// ── Código público ──
const look = await call('GET', `/affiliate/codes/${code}`);
ok(look.data?.valid === true && look.data.agentName === 'Agencia Los Andes', 'código válido muestra el nombre de la agencia');
const lookLower = await call('GET', `/affiliate/codes/${rawCode.toLowerCase()}`);
ok(lookLower.data?.valid === true, 'el código se acepta en minúsculas y sin guion');
const lookBad = await call('GET', '/affiliate/codes/FB-ZZZZZZ');
ok(lookBad.data?.valid === false && Object.keys(lookBad.data).length === 1, 'código inexistente: solo { valid: false }');

// ── Referidos ──
const pReg = await register('Ana', 'Pérez', rawCode.toLowerCase());
ok(pReg.status === 201 && pReg.data.referral?.agentName === 'Agencia Los Andes', 'jugador se registra con el código y queda vinculado');
const player = pReg.data.accessToken;
const qReg = await register('Luis', 'Rondón', 'FB-ZZZZZZ');
ok(qReg.status === 201 && qReg.data.referral === null, 'código inválido no impide el registro (queda sin agencia)');

const summary = async () => (await call('GET', '/agent/summary', { token: agentTok })).data;
const ves = async () => (await summary()).balances.find((b) => b.currency === 'VES');
let s = await summary();
ok(s.referrals.total === 1, 'la agencia ve 1 referido');

const extra = await extraordinary(merida.id, supervisor, true);
ok(extra?.id, 'sorteo extraordinario automático abierto');
const buy = (plays, key = randomUUID()) =>
  call('POST', '/lottery/tickets', { token: player, headers: { 'idempotency-key': key }, body: { gameId: merida.id, currency: 'VES', plays } });

// K6: sin depósito aprobado no hay comisión (protege el bono de bienvenida).
const t0 = await buy([{ drawId: extra.id, symbolId: s1.id, amount: '100' }]);
ok(t0.status === 201, 'referido compra con el bono (sin depósito)');
ok((await ves()).pending === '0', 'sin depósito aprobado → no genera comisión');

const dep = await call('POST', '/payments/deposits', {
  token: player,
  body: { method: 'PAGO_MOVIL', amount: '500', bank: '0105 - Mercantil', reference: `AG${Date.now()}`, payerPhone: '04141234567' },
});
await call('POST', `/admin/payments/deposits/${dep.data.id}/approve`, { token: admin });

// Comisión por liberar: 3 % de Bs 100 + Bs 50 = Bs 4,50.
const t1 = await buy([
  { drawId: extra.id, symbolId: s2.id, amount: '100' },
  { drawId: extra.id, symbolId: s3.id, amount: '50' },
]);
ok(t1.status === 201, 'referido con depósito compra ticket de 2 jugadas (Bs 150)');
ok((await ves()).pending === '450', 'comisión por liberar = Bs 4,50 (3 %)');
const list = (await call('GET', '/agent/commissions', { token: agentTok })).data;
ok(list.items.length === 2 && list.items.every((i) => i.status === 'PENDING' && i.player === 'Ana P.' && i.rate_bps === 300), 'historial: 2 comisiones PENDING, referido enmascarado «Ana P.»');
const playerId = (await call('GET', '/me', { token: player })).data?.id;
ok(playerId && !JSON.stringify(list).includes(playerId), 'el historial no expone el id del jugador');
const refs = (await call('GET', '/agent/referrals', { token: agentTok })).data;
ok(refs.length === 1 && refs[0].name === 'Ana P.' && refs[0].playsMonth === 2 && refs[0].commissionMonth.VES === '450', 'referidos: Ana P. con 2 jugadas y Bs 4,50 en el mes');

// K9: anular el ticket reversa la comisión.
await call('POST', `/lottery/tickets/${t1.data.id}/cancel`, { token: player });
ok((await ves()).pending === '0', 'ticket anulado → comisión reversada');
const afterCancel = (await call('GET', '/agent/commissions', { token: agentTok })).data;
ok(afterCancel.items.filter((i) => i.status === 'REVERSED').length === 2, 'historial muestra 2 comisiones REVERSED');

// Concurrencia: 10 tickets simultáneos → Σ exacta.
await Promise.all(Array.from({ length: 10 }, (_, i) => buy([{ drawId: extra.id, symbolId: merida.symbols[10 + i].id, amount: '10' }])));
ok((await ves()).pending === '300', '10 tickets concurrentes de Bs 10 → Bs 3,00 por liberar');

// Anulación del sorteo: reversa por jugada.
const extra2 = await extraordinary(merida.id, supervisor, true);
await buy([{ drawId: extra2.id, symbolId: s1.id, amount: '20' }]);
ok((await ves()).pending === '360', 'jugada en segundo sorteo suma Bs 0,60');
const cancelDraw = await call('POST', `/admin/lottery/draws/${extra2.id}/cancel`, { token: supervisor, body: { reason: 'Prueba de agencias' } });
ok(cancelDraw.data?.status === 'CANCELLED' && (await ves()).pending === '300', 'sorteo anulado → su comisión se reversa');

// Suspensión: no genera comisiones nuevas.
const agentId = act.data.id;
const sus = await call('POST', `/admin/agents/${agentId}/suspend`, { token: admin, body: { reason: 'Revisión de prueba' } });
ok(sus.data?.status === 'SUSPENDED', 'admin suspende la agencia');
ok((await call('GET', `/affiliate/codes/${code}`)).data.valid === false, 'código de agencia suspendida deja de ser válido');
const tSus = await buy([{ drawId: extra.id, symbolId: merida.symbols[30].id, amount: '10' }]);
ok(tSus.status === 201 && (await ves()).pending === '300', 'jugada durante la suspensión no genera comisión');
await call('POST', `/lottery/tickets/${tSus.data.id}/cancel`, { token: player });
const tr0 = await call('POST', '/agent/transfer-to-player', { token: agentTok, body: { currency: 'VES', amount: '1', idempotencyKey: randomUUID() } });
ok(tr0.data?.code === 'AGENT_SUSPENDED', 'agencia suspendida no puede mover saldo');
await call('POST', `/admin/agents/${agentId}/reactivate`, { token: admin, body: { reason: 'Revisión cerrada' } });

// Sin saldo disponible no se puede pasar a saldo de juego.
const tr1 = await call('POST', '/agent/transfer-to-player', { token: agentTok, body: { currency: 'VES', amount: '1', idempotencyKey: randomUUID() } });
ok(tr1.data?.code === 'INSUFFICIENT_FUNDS', 'sin comisión disponible → saldo insuficiente');

// Tasas y regla K11.
const rates = (await call('GET', '/admin/agents/rates', { token: admin })).data;
const r = (c) => rates.games.find((g) => g.code === c);
ok(rates.productRateBps === 300 && r('MER-05').rateBps === 300 && r('MER-04').rateBps === 0, 'tasas: 3 % general, Terminal Nevado en 0 %');
ok(r('MER-04').minMarginBps === 0 && r('MER-05').minMarginBps === 2857, 'margen mínimo: MER-04 0 %, MER-05 28,57 %');
const unsafe = await call('POST', '/admin/agents/rates', { token: admin, body: { gameId: r('MER-04').gameId, rateBps: 300, reason: 'Prueba K11' } });
ok(unsafe.data?.code === 'RATE_UNSAFE', 'K11: no permite comisión en Terminal Nevado (margen 0 %)');
const notAdmin = await call('POST', '/admin/agents/rates', { token: supervisor, body: { rateBps: 300, reason: 'Sin permiso' } });
ok(notAdmin.status === 403, 'solo ADMIN cambia tasas');
const forbidden = await call('GET', '/agent/summary', { token: admin });
ok(forbidden.status === 403 || forbidden.data?.code === 'AGENT_NOT_FOUND', 'staff no tiene Wallet de agencia');

// Backoffice.
const listAdmin = (await call('GET', `/admin/agents?q=${encodeURIComponent(code)}`, { token: admin })).data;
ok(listAdmin.length === 1 && listAdmin[0].referrals === 1, 'backoffice encuentra la agencia por código');

// Privacidad del saldo de juego: los movimientos AGENT_* no aparecen en /me/transactions.
const myTx = (await call('GET', '/me/transactions', { token: agentTok })).data;
ok(myTx.every((t) => !t.account_type.startsWith('AGENT_')), 'movimientos de agencia separados del historial de juego');

const rec = (await call('GET', '/admin/ledger/reconcile', { token: admin })).data;
ok(rec.ok === true, 'ledger cuadrado (reconciliación OK)');

if (process.argv.includes('--wait')) {
  const until = new Date(extra.draw_at).getTime() + 3 * 60_000;
  console.log(`… esperando la liquidación del sorteo ${extra.draw_at}`);
  let released = false;
  while (Date.now() < until) {
    await sleep(15_000);
    const v = await ves();
    if (v.pending === '0' && v.available === '300') {
      released = true;
      break;
    }
  }
  ok(released, 'sorteo liquidado → Bs 3,00 pasan de «por liberar» a «disponible»');
  const cashBefore = BigInt((await call('GET', '/me/balances', { token: agentTok })).data.find((b) => b.currency === 'VES').cash);
  const key = randomUUID();
  const [a, b] = await Promise.all([
    call('POST', '/agent/transfer-to-player', { token: agentTok, body: { currency: 'VES', amount: '1', idempotencyKey: key } }),
    call('POST', '/agent/transfer-to-player', { token: agentTok, body: { currency: 'VES', amount: '1', idempotencyKey: key } }),
  ]);
  const cashAfter = BigInt((await call('GET', '/me/balances', { token: agentTok })).data.find((b) => b.currency === 'VES').cash);
  ok(a.status === 200 && b.status === 200 && cashAfter - cashBefore === 100n, 'pasar Bs 1,00 a saldo de juego (dos llamadas con la misma clave → un solo movimiento)');
  ok((await ves()).available === '200', 'disponible queda en Bs 2,00');
  ok((await call('GET', '/admin/ledger/reconcile', { token: admin })).data.ok === true, 'ledger cuadrado tras liberar y transferir');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo OK');
process.exit(failures ? 1 : 0);
