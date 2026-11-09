import { describe, expect, it } from 'vitest';
import {
  applyFill,
  bankruptcyPrice,
  bracketFor,
  ContractSpec,
  fee,
  filterOutliers,
  formatFx,
  fundingPayment,
  fundingRate,
  initialMargin,
  isLiquidatable,
  limitTriggered,
  liquidationPrice,
  maintenanceMargin,
  medianFx,
  nextFundingTime,
  notional,
  parseFx,
  stopTriggered,
  tpslTriggered,
  unrealizedPnl,
} from './futures';

const usdt = (s: string) => parseFx(s, 6);
const BTC: ContractSpec = {
  symbol: 'BTCUSDT',
  qtyStep: parseFx('0.001'),
  priceTick: parseFx('0.1'),
  minNotional: usdt('5'),
  maxLeverage: 50,
  takerPpm: 500n,
  makerPpm: 200n,
  liquidationPpm: 5000n,
  brackets: [
    { floor: 0n, cap: usdt('10000'), maxLeverage: 50, mmrPpm: 4000n, cum: 0n },
    { floor: usdt('10000'), cap: usdt('50000'), maxLeverage: 25, mmrPpm: 5000n, cum: usdt('10') },
    { floor: usdt('50000'), cap: usdt('100000'), maxLeverage: 20, mmrPpm: 10000n, cum: usdt('260') },
  ],
};
const ETH: ContractSpec = {
  ...BTC,
  symbol: 'ETHUSDT',
  brackets: [{ floor: 0n, cap: usdt('10000'), maxLeverage: 50, mmrPpm: 5000n, cum: 0n }],
};

describe('Cumbre Futuros · decimales', () => {
  it('parse y formato exactos', () => {
    expect(parseFx('100000')).toBe(10_000_000_000_000n);
    expect(parseFx('0.01')).toBe(1_000_000n);
    expect(formatFx(parseFx('74812.5'))).toBe('74812.5');
    expect(formatFx(parseFx('90361.4457'), 2)).toBe('90361.44');
    expect(parseFx('1.123456789')).toBe(112_345_679n); // redondea a 8 decimales
  });
});

describe('Cumbre Futuros · ejemplo 1 del manual (long BTC 10×)', () => {
  const q = parseFx('0.01');
  const e = parseFx('100000');
  it('nocional, margen, comisión', () => {
    expect(notional(q, e)).toBe(usdt('1000'));
    expect(initialMargin(notional(q, e), 10)).toBe(usdt('100'));
    expect(fee(notional(q, e), BTC.takerPpm)).toBe(usdt('0.5'));
  });
  it('liquidación en 90.361,45 (−9,64 %)', () => {
    const lp = liquidationPrice(BTC, 'LONG', q, e, usdt('100'));
    expect(formatFx(lp, 2)).toBe('90361.44');
    expect(Number(formatFx(lp))).toBeCloseTo(90361.4458, 3);
  });
  it('PnL +50 si sube a 105.000; neto 48,975', () => {
    const pnl = unrealizedPnl('LONG', q, e, parseFx('105000'));
    expect(pnl).toBe(usdt('50'));
    const net = pnl - fee(notional(q, e), 500n) - fee(notional(q, parseFx('105000')), 500n);
    expect(net).toBe(usdt('48.975'));
  });
  it('se liquida justo en el precio de liquidación, no antes', () => {
    const lp = liquidationPrice(BTC, 'LONG', q, e, usdt('100'));
    expect(isLiquidatable(BTC, 'LONG', q, e, usdt('100'), lp)).toBe(true);
    expect(isLiquidatable(BTC, 'LONG', q, e, usdt('100'), lp + parseFx('5'))).toBe(false);
  });
  it('precio de quiebra = entrada − margen ÷ cantidad', () => {
    expect(bankruptcyPrice('LONG', q, e, usdt('100'))).toBe(parseFx('90000'));
  });
});

describe('Cumbre Futuros · ejemplo 2 (short ETH 20×)', () => {
  it('liquidación en 4.179,10 (+4,48 %); PnL +50 si baja a 3.800', () => {
    const q = parseFx('0.25');
    const e = parseFx('4000');
    expect(initialMargin(notional(q, e), 20)).toBe(usdt('50'));
    expect(formatFx(liquidationPrice(ETH, 'SHORT', q, e, usdt('50')), 2)).toBe('4179.10');
    expect(unrealizedPnl('SHORT', q, e, parseFx('3800'))).toBe(usdt('50'));
  });
});

describe('Cumbre Futuros · tramos', () => {
  it('el tramo sube con el nocional y el mantenimiento es continuo', () => {
    expect(bracketFor(BTC, usdt('9000')).maxLeverage).toBe(50);
    expect(bracketFor(BTC, usdt('20000')).maxLeverage).toBe(25);
    expect(bracketFor(BTC, usdt('60000')).maxLeverage).toBe(20);
    // en el borde 10.000: 0,40 % = 40; tramo 2: 0,50 % − 10 = 40
    expect(maintenanceMargin(BTC, usdt('10000'))).toBe(usdt('40'));
    expect(maintenanceMargin(BTC, usdt('10000.000001'))).toBe(usdt('40'));
    expect(maintenanceMargin(BTC, usdt('50000'))).toBe(usdt('240'));
  });
});

describe('Cumbre Futuros · llenados (modo unidireccional)', () => {
  const p = parseFx('100000');
  it('abre, aumenta con precio promedio, reduce y cierra', () => {
    const a = applyFill(null, 'BUY', parseFx('0.01'), p, 10);
    expect(a.position).toMatchObject({ side: 'LONG', qty: parseFx('0.01'), entry: p, margin: usdt('100') });
    const b = applyFill(a.position, 'BUY', parseFx('0.01'), parseFx('110000'), 10);
    expect(b.position!.entry).toBe(parseFx('105000'));
    expect(b.position!.margin).toBe(usdt('210'));
    const c = applyFill(b.position, 'SELL', parseFx('0.01'), parseFx('115000'), 10);
    expect(c.realizedPnl).toBe(usdt('100'));
    expect(c.releasedMargin).toBe(usdt('105'));
    expect(c.position!.qty).toBe(parseFx('0.01'));
    const d = applyFill(c.position, 'SELL', parseFx('0.01'), parseFx('100000'), 10);
    expect(d.position).toBeNull();
    expect(d.realizedPnl).toBe(usdt('-50'));
  });
  it('invierte de long a short', () => {
    const a = applyFill(null, 'BUY', parseFx('0.01'), p, 10);
    const b = applyFill(a.position, 'SELL', parseFx('0.03'), parseFx('101000'), 5);
    expect(b.closedQty).toBe(parseFx('0.01'));
    expect(b.realizedPnl).toBe(usdt('10'));
    expect(b.position).toMatchObject({ side: 'SHORT', qty: parseFx('0.02'), entry: parseFx('101000'), leverage: 5 });
    expect(b.addedMargin).toBe(usdt('404'));
  });
});

describe('Cumbre Futuros · disparos', () => {
  const x = parseFx('100');
  it('límite, stop y TP/SL', () => {
    expect(limitTriggered('BUY', x, parseFx('99'))).toBe(true);
    expect(limitTriggered('BUY', x, parseFx('101'))).toBe(false);
    expect(limitTriggered('SELL', x, parseFx('101'))).toBe(true);
    expect(stopTriggered('BUY', x, parseFx('100'))).toBe(true);
    expect(stopTriggered('SELL', x, parseFx('101'))).toBe(false);
    expect(tpslTriggered('LONG', parseFx('110'), parseFx('110'), parseFx('90'))).toBe('TP');
    expect(tpslTriggered('LONG', parseFx('90'), parseFx('110'), parseFx('90'))).toBe('SL');
    expect(tpslTriggered('SHORT', parseFx('90'), parseFx('90'), parseFx('110'))).toBe('TP');
    expect(tpslTriggered('SHORT', parseFx('100'), parseFx('90'), parseFx('110'))).toBe(null);
  });
});

describe('Cumbre Futuros · funding', () => {
  it('tasa con interés 0,01 % y abrazadera ±0,05 %', () => {
    expect(fundingRate(0n)).toBe(10_000n); // prima 0 → 0,01 %
    expect(fundingRate(30_000n)).toBe(10_000n); // prima 0,03 %: dentro de la banda la tasa queda en el interés
    expect(fundingRate(100_000n)).toBe(50_000n); // prima 0,10 %: interés − prima = −0,09 % → abrazadera −0,05 % → 0,05 %
    expect(fundingRate(1_000_000n)).toBe(300_000n); // tope 0,30 %
  });
  it('ejemplo 3: long de 1.000 USDT con 0,01 % paga 0,10', () => {
    expect(fundingPayment('LONG', usdt('1000'), 10_000n)).toBe(usdt('0.1'));
    expect(fundingPayment('SHORT', usdt('1000'), 10_000n)).toBe(usdt('-0.1'));
  });
  it('próximo funding 00/08/16 UTC', () => {
    expect(nextFundingTime(new Date('2026-11-09T07:59:00Z')).toISOString()).toBe('2026-11-09T08:00:00.000Z');
    expect(nextFundingTime(new Date('2026-11-09T16:00:00Z')).toISOString()).toBe('2026-11-10T00:00:00.000Z');
  });
});

describe('Cumbre Futuros · índice', () => {
  it('mediana y descarte de fuentes desviadas', () => {
    const v = ['100', '101', '99', '150', '100.5'].map((s) => parseFx(s));
    const ok = filterOutliers(v);
    expect(ok).toHaveLength(4);
    expect(formatFx(medianFx(ok))).toBe('100.25');
  });
});
