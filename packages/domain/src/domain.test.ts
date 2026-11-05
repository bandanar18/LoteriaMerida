import { describe, expect, it } from 'vitest';
import {
  aggregateTicketStatus,
  ageOn,
  applyMultiplier,
  canTransition,
  DEFAULT_ANIMALS,
  encodeTicketCode,
  fairIndex,
  fitsExposure,
  formatAmount,
  hashSeed,
  isAdult,
  isValidDocument,
  newServerSeed,
  normalizeVePhone,
  parseAmount,
  parseScaled100,
  settlePlay,
  validatePlays,
  verifyDraw,
} from './index';

describe('money', () => {
  it('parsea y formatea sin flotantes', () => {
    expect(parseAmount('12.5', 'VES')).toBe(1250n);
    expect(parseAmount('12,50', 'VES')).toBe(1250n);
    expect(parseAmount('0.000001', 'USDT')).toBe(1n);
    expect(formatAmount(1250n, 'VES')).toBe('12.50');
    expect(formatAmount(-5n, 'VES')).toBe('-0.05');
    expect(formatAmount(1_500_000n, 'USDT')).toBe('1.500000');
  });

  it('rechaza montos inválidos', () => {
    for (const bad of ['', '-1', '1e3', '1.234', 'abc', '1.2.3']) {
      expect(() => parseAmount(bad, 'VES')).toThrow();
    }
  });

  it('aplica multiplicador escalado', () => {
    expect(parseScaled100('30')).toBe(3000n);
    expect(parseScaled100('30.00')).toBe(3000n);
    expect(applyMultiplier(1000n, 3000n)).toBe(30000n);
    expect(applyMultiplier(1n, 150n)).toBe(1n); // redondeo hacia abajo
  });
});

describe('animalitos', () => {
  it('tiene 38 símbolos únicos', () => {
    expect(DEFAULT_ANIMALS).toHaveLength(38);
    expect(new Set(DEFAULT_ANIMALS.map((a) => a.number)).size).toBe(38);
  });

  it('RTP teórico = 30/38 ≈ 78,95 %', () => {
    const stake = 100n;
    const totalWins = DEFAULT_ANIMALS.reduce(
      (acc, a) => acc + settlePlay({ symbolId: '5', amount: stake }, a.number, 3000n).win,
      0n,
    );
    const rtp = Number(totalWins) / Number(stake * 38n);
    expect(rtp).toBeCloseTo(30 / 38, 10);
  });

  const limits = { minPlay: 100n, maxPlay: 100_000n, maxTicket: 500_000n };

  it('valida jugadas', () => {
    expect(validatePlays([], limits)).toEqual({ code: 'EMPTY_TICKET' });
    expect(validatePlays([{ drawId: 'd', symbolId: 's', amount: 50n }], limits)?.code).toBe('PLAY_BELOW_MIN');
    expect(validatePlays([{ drawId: 'd', symbolId: 's', amount: 200_000n }], limits)?.code).toBe('PLAY_ABOVE_MAX');
    expect(
      validatePlays(
        [
          { drawId: 'd', symbolId: 's', amount: 100n },
          { drawId: 'd', symbolId: 's', amount: 100n },
        ],
        limits,
      )?.code,
    ).toBe('DUPLICATE_PLAY');
    const many = Array.from({ length: 6 }, (_, i) => ({ drawId: 'd', symbolId: `s${i}`, amount: 100_000n }));
    expect(validatePlays(many, limits)?.code).toBe('TICKET_ABOVE_MAX');
    expect(validatePlays([{ drawId: 'd', symbolId: 's', amount: 1000n }], limits)).toBeNull();
  });

  it('respeta el cupo por animal', () => {
    // cupo 30.000 → caben 1.000 apostados a 30×
    expect(fitsExposure(900n, 100n, 3000n, 30_000n)).toBe(true);
    expect(fitsExposure(900n, 101n, 3000n, 30_000n)).toBe(false);
  });

  it('agrega estado de ticket', () => {
    expect(aggregateTicketStatus(['OPEN', 'WON'])).toBe('OPEN');
    expect(aggregateTicketStatus(['LOST', 'WON'])).toBe('WON');
    expect(aggregateTicketStatus(['LOST', 'VOID'])).toBe('LOST');
    expect(aggregateTicketStatus(['VOID', 'VOID'])).toBe('VOID');
  });

  it('máquina de estados del sorteo', () => {
    expect(canTransition('OPEN', 'CLOSED')).toBe(true);
    expect(canTransition('CLOSED', 'OPEN')).toBe(false);
    expect(canTransition('SETTLED', 'CANCELLED')).toBe(false);
  });

  it('códigos de ticket legibles', () => {
    const code = encodeTicketCode(new Uint8Array(10).fill(255));
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
  });
});

describe('provably fair', () => {
  it('es determinista y verificable', () => {
    const seed = newServerSeed();
    const hash = hashSeed(seed);
    const a = fairIndex(seed, 'draw-1', 38);
    expect(fairIndex(seed, 'draw-1', 38)).toBe(a);
    const v = verifyDraw(seed, hash, 'draw-1', 38);
    expect(v.hashMatches).toBe(true);
    expect(v.index).toBe(a);
    expect(verifyDraw(newServerSeed(), hash, 'draw-1', 38).hashMatches).toBe(false);
  });

  it('distribución uniforme en 38 (chi-cuadrado)', () => {
    const n = 38;
    const samples = 76_000;
    const counts = new Array(n).fill(0);
    const seed = newServerSeed();
    for (let i = 0; i < samples; i++) counts[fairIndex(seed, `m${i}`, n)]++;
    const expected = samples / n;
    const chi2 = counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
    // gl = 37; valor crítico al 99,9 % ≈ 69.3
    expect(chi2).toBeLessThan(69.3);
  });
});

describe('identidad', () => {
  it('valida mayoría de edad', () => {
    expect(ageOn('2008-11-04', '2026-11-04')).toBe(18);
    expect(isAdult('2008-11-05', '2026-11-04')).toBe(false);
    expect(isAdult('2008-11-04', '2026-11-04')).toBe(true);
  });

  it('valida documentos y teléfonos', () => {
    expect(isValidDocument('V', '12345678')).toBe(true);
    expect(isValidDocument('V', '12A45678')).toBe(false);
    expect(isValidDocument('P', 'AB123456')).toBe(true);
    expect(normalizeVePhone('0414-123.45.67')).toBe('584141234567');
    expect(normalizeVePhone('+58 424 1234567')).toBe('584241234567');
    expect(normalizeVePhone('123')).toBeNull();
  });
});
