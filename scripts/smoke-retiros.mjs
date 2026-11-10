// Prueba end-to-end de la Fase 3 del Programa de Agencias: Directorio de Pago Móvil con SMS (DEMO),
// tasa BCV y retiros SOLO en bolívares por Pago Móvil (desde Bs o desde USDT).
//   node scripts/smoke-retiros.mjs
// Tarda ~10 min: espera que un sorteo automático se liquide para que haya comisiones disponibles.
// Usa la cuenta prueba1@fortunabet.test (KYC nivel 2) como agencia.
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
const login = async (email, password) => (await call('POST', '/auth/login', { body: { email, password } })).data?.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const phone = () => `0414${randomInt(1_000_000, 9_999_999)}`;
const doc = () => String(randomInt(10_000_000, 30_000_000));

async function register(first, last, referralCode) {
  const d = doc();
  const r = await call('POST', '/auth/register', {
    body: {
      firstName: first, lastName: last, documentType: 'V', documentNumber: d, birthDate: '1990-05-10', phone: phone(),
      email: `retiros.${randomUUID().slice(0, 8)}@prueba.test`, password: 'Prueba.Retiros.2026', currency: 'VES', acceptDemoTerms: true,
      ...(referralCode ? { referralCode } : {}),
    },
  });
  return { ...r, doc: d };
}
async function addPayout(token, body) {
  const ch = await call('POST', '/agent/payout-accounts/challenge', { token, body });
  if (ch.status !== 200) return { ch };
  const cf = await call('POST', '/agent/payout-accounts/confirm', { token, body: { challengeId: ch.data.challengeId, code: ch.data.demoCode } });
  return { ch, cf };
}

const admin = await login(env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD);
const supervisor = await login(env.SEED_SUPERVISOR_EMAIL, env.SEED_SUPERVISOR_PASSWORD);
ok(admin && supervisor, 'login de admin y supervisor');

// ── Catálogo y tasa BCV ──
const banks = (await call('GET', '/affiliate/banks')).data;
ok(banks.length >= 20 && banks.some((b) => b.code === '0134' && b.name === 'Banesco'), `catálogo de ${banks.length} bancos con Pago Móvil`);
const badRate = await call('POST', '/admin/agents/fx-rates', { token: admin, body: { rate: '45,123456' } });
ok(badRate.data?.code === 'INVALID_INPUT', 'tasa con más de 4 decimales se rechaza');
const noAdmin = await call('POST', '/admin/agents/fx-rates', { token: supervisor, body: { rate: '45,20' } });
ok(noAdmin.status === 403, 'solo ADMIN carga la tasa');
await call('POST', '/admin/agents/fx-rates', { token: admin, body: { rate: '45,20', confirmLargeChange: true } });
const jump = await call('POST', '/admin/agents/fx-rates', { token: admin, body: { rate: '60' } });
ok(jump.data?.code === 'FX_RATE_JUMP', 'salto de tasa > 10 % pide confirmación');
const today = (await call('GET', '/affiliate/fx/today')).data;
ok(today?.rate === '45,2000' && today.source === 'BCV', 'tasa BCV del día: 45,2000');

// ── Parte A: directorio con una agencia nueva (KYC 1) ──
const dirReg = await register('Diana', 'Molina');
const dir = dirReg.data.accessToken;
const dirAgent = await call('POST', '/agent', { token: dir, body: { displayName: 'Agencia Directorio', acceptTerms: true } });
const dirCode = dirAgent.data.code;
const ref = await register('Pedro', 'Rivas', dirCode);
ok(ref.data?.referral?.agentName === 'Agencia Directorio', 'referido de la agencia de prueba');

const selfPhone = phone();
const ch1 = await call('POST', '/agent/payout-accounts/challenge', { token: dir, body: { alias: 'Mi Banesco', holderKind: 'SELF', bankCode: '0134', phone: selfPhone } });
ok(ch1.status === 200 && ch1.data.delivery === 'DEMO_SCREEN' && /^\d{6}$/.test(ch1.data.demoCode), `DEMO: el SMS no se envía, el código va a la pantalla (${ch1.data?.demoCode})`);
ok(/^0414-\*\*\*-\d{4}$/.test(ch1.data.maskedPhone), `código «enviado» al teléfono registrado (${ch1.data.maskedPhone})`);
const wrong = await call('POST', '/agent/payout-accounts/confirm', { token: dir, body: { challengeId: ch1.data.challengeId, code: ch1.data.demoCode === '000000' ? '111111' : '000000' } });
ok(wrong.data?.code === 'SMS_CODE_INVALID' && /2 intento/.test(wrong.data.message), 'código incorrecto: quedan 2 intentos');
const okc = await call('POST', '/agent/payout-accounts/confirm', { token: dir, body: { challengeId: ch1.data.challengeId, code: ch1.data.demoCode } });
ok(okc.status === 201, 'código correcto guarda el Pago Móvil');
const reuse = await call('POST', '/agent/payout-accounts/confirm', { token: dir, body: { challengeId: ch1.data.challengeId, code: ch1.data.demoCode } });
ok(reuse.data?.code === 'SMS_CODE_EXPIRED', 'un código no se puede usar dos veces');
let list = (await call('GET', '/agent/payout-accounts', { token: dir })).data;
ok(list.length === 1 && list[0].isDefault && list[0].holderKind === 'SELF' && list[0].holderName === 'Diana Molina', 'cuenta propia: titular y cédula del dueño, predeterminada');
ok(!JSON.stringify(list).includes(selfPhone.slice(4)) && !JSON.stringify(list).includes(dirReg.doc), 'el directorio muestra teléfono y cédula enmascarados');

const rl = await call('POST', '/agent/payout-accounts/challenge', { token: dir, body: { alias: 'Otro', holderKind: 'SELF', bankCode: '0105', phone: phone() } });
ok(rl.data?.code === 'SMS_RATE_LIMITED', 'un código por minuto');
const ownDoc = await call('POST', '/agent/payout-accounts/challenge', {
  token: dir, body: { alias: 'Yo', holderKind: 'FAMILY', relationship: 'HERMANO', holderName: 'Diana Molina', documentType: 'V', documentNumber: dirReg.doc, bankCode: '0105', phone: phone() },
});
ok(ownDoc.data?.code === 'PAYOUT_HOLDER_MISMATCH', 'familiar con la propia cédula: debe elegir «Mía»');
const refDoc = await call('POST', '/agent/payout-accounts/challenge', {
  token: dir, body: { alias: 'Pedro', holderKind: 'FAMILY', relationship: 'PRIMO', holderName: 'Pedro Rivas', documentType: 'V', documentNumber: ref.doc, bankCode: '0105', phone: phone() },
});
ok(refDoc.data?.code === 'PAYOUT_HOLDER_IS_REFERRAL', 'P9: no se puede cobrar en el Pago Móvil de un referido');
const landline = await call('POST', '/agent/payout-accounts/challenge', { token: dir, body: { alias: 'Fijo', holderKind: 'SELF', bankCode: '0105', phone: '02121234567' } });
ok(landline.data?.code === 'INVALID_INPUT', 'Pago Móvil exige celular (no fijo)');
const dup = await call('POST', '/agent/payout-accounts/challenge', { token: dir, body: { alias: 'Repetido', holderKind: 'SELF', bankCode: '0134', phone: selfPhone } });
ok(dup.data?.code === 'PAYOUT_ACCOUNT_DUPLICATE', 'no se repite banco + teléfono');
const noKyc = await call('POST', '/agent/withdrawals', { token: dir, body: { sourceCurrency: 'VES', amount: '100', payoutAccountId: list[0].id, idempotencyKey: randomUUID() } });
ok(noKyc.data?.code === 'KYC_REQUIRED' || noKyc.data?.code === 'INSUFFICIENT_FUNDS', `retiro exige verificación o saldo (${noKyc.data?.code})`);

console.log('… esperando 61 s (límite de 1 SMS por minuto)');
await sleep(61_000);
const fam = await addPayout(dir, {
  alias: 'Banesco de mamá', holderKind: 'FAMILY', relationship: 'PADRE_MADRE', holderName: 'Carmen Molina', documentType: 'V', documentNumber: doc(), bankCode: '0134', phone: phone(), isDefault: true,
});
ok(fam.cf?.status === 201, 'Pago Móvil de un familiar (madre) confirmado por SMS');
list = (await call('GET', '/agent/payout-accounts', { token: dir })).data;
const mom = list.find((a) => a.holderKind === 'FAMILY');
ok(list.length === 2 && mom?.isDefault && mom.relationship === 'PADRE_MADRE' && mom.holderName === 'Carmen Molina', 'familiar guardado como predeterminada con parentesco y titular');
await call('PATCH', `/agent/payout-accounts/${mom.id}`, { token: dir, body: { alias: 'Mamá' } });
const del = await call('DELETE', `/agent/payout-accounts/${list.find((a) => a.holderKind === 'SELF').id}`, { token: dir });
list = (await call('GET', '/agent/payout-accounts', { token: dir })).data;
ok(del.data?.deleted && list.length === 1 && list[0].alias === 'Mamá', 'cambiar nombre sin SMS y eliminar una cuenta');

// ── Parte B: retiros con prueba1 (KYC 2) ──
const agent = await login('prueba1@fortunabet.test', env.SEED_TEST_PLAYERS_PASSWORD);
let me = await call('GET', '/agent/me', { token: agent });
if (me.data?.code === 'AGENT_NOT_FOUND') me = await call('POST', '/agent', { token: agent, body: { displayName: 'Agencia Prueba Uno', acceptTerms: true } });
const code = me.data.code;
let accounts = (await call('GET', '/agent/payout-accounts', { token: agent })).data;
let target = accounts.find((a) => a.status === 'ACTIVE');
if (!target) {
  const r = await addPayout(agent, { alias: `Pago ${randomInt(100, 999)}`, holderKind: 'SELF', bankCode: '0102', phone: phone() });
  ok(r.cf?.status === 201, 'prueba1: Pago Móvil propio agregado');
  accounts = (await call('GET', '/agent/payout-accounts', { token: agent })).data;
  target = accounts.find((a) => a.status === 'ACTIVE');
}
ok(!!target, `prueba1 cobra en «${target?.alias}»`);

const bal = async (cur) => (await call('GET', '/agent/summary', { token: agent })).data.balances.find((b) => b.currency === cur);
const startVes = await bal('VES');
const startUsdt = await bal('USDT');

const pl = await register('Rosa', 'Linares', code);
const player = pl.data.accessToken;
for (const [method, amount, bank] of [['PAGO_MOVIL', '5000', '0134 - Banesco'], ['USDT', '90', 'TRC-20']]) {
  const d = await call('POST', '/payments/deposits', { token: player, body: { method, amount, bank, reference: `RT${Date.now()}${method.slice(0, 2)}` } });
  await call('POST', `/admin/payments/deposits/${d.data.id}/approve`, { token: admin });
}
const games = (await call('GET', '/lottery/games')).data;
const mer = games.find((g) => g.code === 'MER-05');
let extra;
for (let m = 7; m < 20 && !extra?.id; m++) {
  const r = await call('POST', `/admin/lottery/games/${mer.id}/extraordinary-draw`, { token: supervisor, body: { minutesFromNow: m, auto: true } });
  if (r.status === 201) extra = r.data;
}
const buy = (currency, plays) => call('POST', '/lottery/tickets', { token: player, headers: { 'idempotency-key': randomUUID() }, body: { gameId: mer.id, currency, plays } });
const tv = await buy('VES', [{ drawId: extra.id, symbolId: mer.symbols[0].id, amount: '2000' }, { drawId: extra.id, symbolId: mer.symbols[1].id, amount: '2000' }]);
const tu = await buy('USDT', [{ drawId: extra.id, symbolId: mer.symbols[2].id, amount: '40' }, { drawId: extra.id, symbolId: mer.symbols[3].id, amount: '40' }]);
ok(tv.status === 201 && tu.status === 201, `referida juega Bs 4.000 y 80 USDT (${tv.data?.code ?? tv.data?.message} / ${tu.data?.code ?? tu.data?.message})`);
const pv = await bal('VES');
const pu = await bal('USDT');
ok(BigInt(pv.pending) - BigInt(startVes.pending) === 12000n && BigInt(pu.pending) - BigInt(startUsdt.pending) === 2_400_000n, 'por liberar: +Bs 120,00 y +2,40 USDT');

console.log(`… esperando la liquidación del sorteo de las ${new Date(extra.draw_at).toLocaleTimeString('es-VE')}`);
const until = new Date(extra.draw_at).getTime() + 4 * 60_000;
let released = false;
while (Date.now() < until && !released) {
  await sleep(15_000);
  const v = await bal('VES');
  released = BigInt(v.available) - BigInt(startVes.available) >= 12000n;
}
ok(released, 'sorteo liquidado: comisiones disponibles');

// Bs: mínimo, idempotencia y pago.
const tooSmall = await call('POST', '/agent/withdrawals', { token: agent, body: { sourceCurrency: 'VES', amount: '50', payoutAccountId: target.id, idempotencyKey: randomUUID() } });
ok(tooSmall.data?.code === 'MIN_AMOUNT', 'retiro menor a Bs 100 se rechaza');
const qv = (await call('GET', '/agent/withdrawals/quote?sourceCurrency=VES&amount=100', { token: agent })).data;
ok(qv.payoutVes === '10000' && qv.rate === null, 'cotización en Bs: recibe Bs 100,00 sin tasa');
const key = randomUUID();
const before = await bal('VES');
const [w1, w2] = await Promise.all([0, 1].map(() => call('POST', '/agent/withdrawals', { token: agent, body: { sourceCurrency: 'VES', amount: '100', payoutAccountId: target.id, idempotencyKey: key } })));
const afterReq = await bal('VES');
ok(w1.status === 201 && w2.status === 201 && w1.data.id === w2.data.id, 'dos solicitudes con la misma clave → un solo retiro');
ok(BigInt(before.available) - BigInt(afterReq.available) === 10000n && BigInt(afterReq.locked) - BigInt(before.locked) === 10000n, 'Bs 100,00 pasan de disponible a «en trámite»');
const busy = await call('DELETE', `/agent/payout-accounts/${target.id}`, { token: agent });
ok(busy.data?.code === 'PAYOUT_ACCOUNT_IN_USE', 'no se puede borrar un Pago Móvil con retiro en trámite');
const queue = (await call('GET', '/admin/payments/withdrawals?status=REQUESTED', { token: admin })).data;
const row = queue.find((w) => w.id === w1.data.id);
ok(row?.source === 'AGENT' && row.method === 'PAGO_MOVIL' && row.currency === 'VES' && row.destination.phone && row.agent_name, 'caja ve el retiro de agencia con banco, teléfono y cédula para pagar');
const paid = await call('POST', `/admin/payments/withdrawals/${w1.data.id}/pay`, { token: admin, body: { paidReference: 'PM123456' } });
ok(paid.data?.status === 'PAID' && (await bal('VES')).locked === before.locked, 'caja paga: «en trámite» vuelve a 0');

// USDT → Bs con tasa congelada; rechazo devuelve los USDT exactos y marca el Pago Móvil.
const qu = (await call('GET', '/agent/withdrawals/quote?sourceCurrency=USDT&amount=2.4', { token: agent })).data;
ok(qu.payoutVes === '10848' && qu.rate === '45,2000', 'cotización: 2,40 USDT × 45,20 = Bs 108,48');
const usdtBefore = await bal('USDT');
const wu = await call('POST', '/agent/withdrawals', { token: agent, body: { sourceCurrency: 'USDT', amount: '2.4', payoutAccountId: target.id, idempotencyKey: randomUUID() } });
ok(wu.status === 201 && wu.data.payoutVes === '10848', 'retiro desde USDT se paga en Bs (Bs 108,48)');
await call('POST', '/admin/agents/fx-rates', { token: admin, body: { rate: '50', confirmLargeChange: true } });
const urow = (await call('GET', '/admin/payments/withdrawals?status=REQUESTED', { token: admin })).data.find((w) => w.id === wu.data.id);
ok(urow?.amount === '10848' && urow.source_currency === 'USDT' && urow.source_amount === '2400000' && urow.fx_rate_e4 === '452000', 'cambiar la tasa después no altera el retiro (tasa congelada)');
const rej = await call('POST', `/admin/payments/withdrawals/${wu.data.id}/reject`, { token: admin, body: { reason: 'El banco devolvió el pago', invalidPayout: true } });
const usdtAfter = await bal('USDT');
ok(rej.data?.status === 'REJECTED' && usdtAfter.available === usdtBefore.available, 'rechazo: vuelven exactamente los 2,40 USDT');
const inv = (await call('GET', '/agent/payout-accounts', { token: agent })).data.find((a) => a.id === target.id);
ok(inv?.status === 'INVALID' && inv.invalidReason === 'El banco devolvió el pago', 'caja marcó el Pago Móvil con datos incorrectos');
const blocked = await call('POST', '/agent/withdrawals', { token: agent, body: { sourceCurrency: 'VES', amount: '100', payoutAccountId: target.id, idempotencyKey: randomUUID() } });
ok(blocked.data?.code === 'PAYOUT_ACCOUNT_INVALID', 'no se retira a un Pago Móvil con datos incorrectos');
const hist = (await call('GET', '/agent/withdrawals', { token: agent })).data;
ok(hist.some((h) => h.id === wu.data.id && h.status === 'REJECTED' && h.rate === '45,2000'), 'historial de retiros con tasa usada');
const playerW = (await call('GET', '/payments/withdrawals', { token: agent })).data;
ok(playerW.every((w) => w.id !== w1.data.id), 'los retiros de agencia no aparecen en los retiros de jugador');

await call('POST', '/admin/agents/fx-rates', { token: admin, body: { rate: '45,20', confirmLargeChange: true } });
ok((await call('GET', '/admin/ledger/reconcile', { token: admin })).data.ok === true, 'ledger cuadrado (reconciliación OK)');

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo OK');
process.exit(failures ? 1 : 0);
