import { describe, expect, it } from 'vitest';
import {
  americanToOdds,
  combinedOdds,
  formatLine,
  formatOdds,
  marketMarginBps,
  oddsAccepted,
  parseLine,
  parseOdds,
  selectionName,
  settleSelection,
  settleSlip,
  slipPayout,
  sniffMime,
  validateKycRequest,
  validateSlip,
} from './index';

describe('cuotas', () => {
  it('parsea y formatea sin flotantes', () => {
    expect(parseOdds('2.1')).toBe(21_000n);
    expect(parseOdds('2,10')).toBe(21_000n);
    expect(parseOdds('1.0525')).toBe(10_525n);
    expect(formatOdds(21_000n)).toBe('2.10');
    expect(formatOdds(21_050n)).toBe('2.105');
    expect(() => parseOdds('1.00')).toThrow();
    expect(() => parseOdds('2.12345')).toThrow();
    expect(americanToOdds(150)).toBe(25_000n);
    expect(americanToOdds(-200)).toBe(15_000n);
  });

  it('calcula el margen del mercado (ejemplo del Doc. Maestro §7.2)', () => {
    expect(marketMarginBps([21_000n, 33_000n, 36_000n])).toBe(570);
  });

  it('parsea líneas enteras y de medio punto', () => {
    expect(parseLine('-1.5')).toBe(-150);
    expect(parseLine('2.5')).toBe(250);
    expect(parseLine('3')).toBe(300);
    expect(() => parseLine('2.25')).toThrow();
    expect(formatLine(-150)).toBe('-1.5');
    expect(selectionName('{home} {line}', { home: 'Leones', away: 'Magallanes', line: -150 })).toBe('Leones -1.5');
    expect(selectionName('{away} {-line}', { home: 'Leones', away: 'Magallanes', line: -150 })).toBe('Magallanes +1.5');
    expect(selectionName('Más de {line}', { home: 'A', away: 'B', line: 250 })).toBe('Más de 2.5');
  });
});

describe('liquidación de mercados', () => {
  const s = (home: number, away: number) => ({ home, away });

  it('1X2, doble oportunidad y empate no válido', () => {
    expect(settleSelection('MATCH_RESULT', null, '1', s(2, 1))).toBe('WIN');
    expect(settleSelection('MATCH_RESULT', null, 'X', s(2, 1))).toBe('LOSE');
    expect(settleSelection('MATCH_RESULT', null, 'X', s(1, 1))).toBe('WIN');
    expect(settleSelection('DOUBLE_CHANCE', null, '1X', s(1, 1))).toBe('WIN');
    expect(settleSelection('DOUBLE_CHANCE', null, '12', s(1, 1))).toBe('LOSE');
    expect(settleSelection('DRAW_NO_BET', null, '1', s(0, 0))).toBe('VOID');
    expect(settleSelection('DRAW_NO_BET', null, '2', s(0, 1))).toBe('WIN');
  });

  it('totales con push en línea entera', () => {
    expect(settleSelection('TOTAL_GOALS', 250, 'OVER', s(2, 1))).toBe('WIN');
    expect(settleSelection('TOTAL_GOALS', 250, 'UNDER', s(2, 1))).toBe('LOSE');
    expect(settleSelection('TOTAL_GOALS', 300, 'OVER', s(2, 1))).toBe('VOID');
    expect(settleSelection('TOTAL_RUNS', 850, 'UNDER', s(4, 3))).toBe('WIN');
    expect(settleSelection('BTTS', null, 'YES', s(1, 1))).toBe('WIN');
    expect(settleSelection('BTTS', null, 'NO', s(2, 0))).toBe('WIN');
  });

  it('run line: hándicap al local, opuesto al visitante', () => {
    expect(settleSelection('RUN_LINE', -150, '1', s(5, 3))).toBe('WIN');
    expect(settleSelection('RUN_LINE', -150, '1', s(4, 3))).toBe('LOSE');
    expect(settleSelection('RUN_LINE', -150, '2', s(4, 3))).toBe('WIN');
    expect(settleSelection('RUN_LINE', 150, '1', s(2, 3))).toBe('WIN');
    expect(settleSelection('MONEYLINE', null, '2', s(2, 3))).toBe('WIN');
  });
});

describe('cupones', () => {
  const limits = { minStake: 1_000n, maxStake: 500_000n, maxPayout: 50_000_000n, maxTotalOdds: 5_000_000n };

  it('valida simples y combinadas', () => {
    const leg = (eventId: string, odds = 20_000n) => ({ eventId, odds });
    expect(validateSlip('SINGLE', [leg('a')], 10_000n, limits)).toBeNull();
    expect(validateSlip('SINGLE', [leg('a'), leg('b')], 10_000n, limits)?.code).toBe('SINGLE_NEEDS_ONE_LEG');
    expect(validateSlip('PARLAY', [leg('a')], 10_000n, limits)?.code).toBe('PARLAY_LEGS');
    expect(validateSlip('PARLAY', [leg('a'), leg('a')], 10_000n, limits)?.code).toBe('SAME_EVENT');
    expect(validateSlip('SINGLE', [leg('a')], 999n, limits)?.code).toBe('STAKE_BELOW_MIN');
    expect(validateSlip('SINGLE', [leg('a', 9_000_000n)], 10_000n, limits)?.code).toBe('ODDS_ABOVE_MAX');
    expect(validateSlip('SINGLE', [leg('a', 2_000_000n)], 500_000n, limits)?.code).toBe('PAYOUT_ABOVE_MAX');
  });

  it('paga el producto de cuotas redondeando una sola vez', () => {
    expect(combinedOdds([21_000n, 18_500n])).toBe(38_850n);
    expect(slipPayout(1_000n, [21_000n, 18_500n])).toBe(3_885n);
    expect(slipPayout(333n, [33_333n, 33_333n])).toBe(3_699n); // 333 × 11.11088889 = 3699.92 → 3699
  });

  it('liquida combinadas: una pierde → LOST; VOID cuenta como 1.00', () => {
    expect(settleSlip(1_000n, [{ odds: 20_000n, result: 'LOSE' }, { odds: 20_000n, result: null }])).toEqual({ status: 'LOST', payout: 0n });
    expect(settleSlip(1_000n, [{ odds: 20_000n, result: 'WIN' }, { odds: 20_000n, result: null }]).status).toBe('OPEN');
    expect(settleSlip(1_000n, [{ odds: 20_000n, result: 'WIN' }, { odds: 30_000n, result: 'VOID' }])).toEqual({ status: 'WON', payout: 2_000n });
    expect(settleSlip(1_000n, [{ odds: 20_000n, result: 'VOID' }])).toEqual({ status: 'VOID', payout: 1_000n });
  });

  it('aplica la política de cambio de cuota', () => {
    expect(oddsAccepted('NONE', 20_000n, 20_000n)).toBe(true);
    expect(oddsAccepted('NONE', 20_000n, 21_000n)).toBe(false);
    expect(oddsAccepted('ACCEPT_HIGHER', 20_000n, 21_000n)).toBe(true);
    expect(oddsAccepted('ACCEPT_HIGHER', 20_000n, 19_000n)).toBe(false);
    expect(oddsAccepted('ACCEPT_ANY', 20_000n, 19_000n)).toBe(true);
  });
});

describe('kyc', () => {
  it('exige los documentos de cada nivel', () => {
    expect(validateKycRequest(1, 2, ['ID_FRONT', 'SELFIE'])).toBeNull();
    expect(validateKycRequest(1, 2, ['ID_FRONT'])).toMatch(/Selfie/);
    expect(validateKycRequest(1, 3, ['PROOF_OF_ADDRESS', 'SOURCE_OF_FUNDS'])).toMatch(/nivel 2/);
    expect(validateKycRequest(2, 2, ['ID_FRONT', 'SELFIE'])).toMatch(/Ya tienes/);
    expect(validateKycRequest(2, 3, ['PROOF_OF_ADDRESS', 'SOURCE_OF_FUNDS', 'SELFIE'])).toMatch(/no corresponde/);
  });

  it('detecta el tipo de archivo por su firma', () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(new TextEncoder().encode('<script>'))).toBeNull();
  });
});

describe('liquidación de básquet, hockey y fútbol americano', () => {
  const s = (home: number, away: number) => ({ home, away });
  it('ganador sin empate y totales con línea .5 o entera', () => {
    expect(settleSelection('BASKETBALL_MONEYLINE', null, '1', s(112, 108))).toBe('WIN');
    expect(settleSelection('BASKETBALL_MONEYLINE', null, '2', s(112, 108))).toBe('LOSE');
    expect(settleSelection('BASKETBALL_TOTAL', 22050, 'OVER', s(112, 108))).toBe('LOSE');
    expect(settleSelection('BASKETBALL_TOTAL', 22000, 'UNDER', s(112, 108))).toBe('VOID');
    expect(settleSelection('BASKETBALL_TOTAL', 22000, 'OVER', s(110, 110))).toBe('VOID');
    expect(settleSelection('HOCKEY_MONEYLINE', null, '2', s(2, 3))).toBe('WIN');
    expect(settleSelection('HOCKEY_TOTAL', 550, 'OVER', s(4, 2))).toBe('WIN');
    expect(settleSelection('GRIDIRON_MONEYLINE', null, '1', s(21, 21))).toBe('VOID');
    expect(settleSelection('GRIDIRON_TOTAL', 4450, 'UNDER', s(20, 21))).toBe('WIN');
  });
});
