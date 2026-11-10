import { describe, expect, it } from 'vitest';
import {
  AFFILIATE_ALPHABET,
  buildAffiliateCode,
  commissionFor,
  formatAffiliateCode,
  houseMarginBps,
  isCommissionRateSafe,
  maskPlayerName,
  modalityMarginBps,
  normalizeAffiliateCode,
} from './affiliate';

describe('código de afiliado', () => {
  it('usa Crockford Base32 (sin I, L, O, U)', () => {
    expect(AFFILIATE_ALPHABET).toHaveLength(32);
    expect(AFFILIATE_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it('construye FB + 6 caracteres', () => {
    expect(buildAffiliateCode([7, 19, 3, 23, 9, 29])).toBe('FB7K3Q9X');
    expect(() => buildAffiliateCode([1, 2, 3])).toThrow();
    expect(() => buildAffiliateCode([1, 2, 3, 4, 5, 32])).toThrow();
  });

  it('normaliza lo que escribe el usuario', () => {
    expect(normalizeAffiliateCode('FB-7K3Q9X')).toBe('FB7K3Q9X');
    expect(normalizeAffiliateCode('fb7k3q9x')).toBe('FB7K3Q9X');
    expect(normalizeAffiliateCode(' fb 7k3q9o ')).toBe('FB7K3Q90');
    expect(normalizeAffiliateCode('FB-1LI000')).toBe('FB111000');
    expect(normalizeAffiliateCode('FB-7K3Q9')).toBeNull();
    expect(normalizeAffiliateCode('XX7K3Q9X')).toBeNull();
    expect(normalizeAffiliateCode('FB7K3Q9U')).toBeNull();
    expect(normalizeAffiliateCode('')).toBeNull();
    expect(normalizeAffiliateCode(undefined)).toBeNull();
  });

  it('formatea con guion', () => {
    expect(formatAffiliateCode('FB7K3Q9X')).toBe('FB-7K3Q9X');
  });
});

describe('comisión', () => {
  it('3 % de Bs 100,00 = Bs 3,00', () => {
    expect(commissionFor(10000n, 300)).toEqual({ amount: 300n, capped: false });
  });

  it('redondea hacia abajo', () => {
    expect(commissionFor(15050n, 300).amount).toBe(451n); // 451,5 → 451
    expect(commissionFor(33n, 300).amount).toBe(0n); // menos de 1 céntimo
    expect(commissionFor(34n, 300).amount).toBe(1n);
  });

  it('USDT en micro-unidades', () => {
    expect(commissionFor(5_000_000n, 300).amount).toBe(150_000n); // 5 USDT → 0,15 USDT
  });

  it('aplica el tope por jugada', () => {
    expect(commissionFor(10_000_000n, 300, 5000n)).toEqual({ amount: 5000n, capped: true });
    expect(commissionFor(10000n, 300, 5000n)).toEqual({ amount: 300n, capped: false });
  });

  it('no desborda con montos grandes', () => {
    expect(commissionFor(10n ** 15n, 300).amount).toBe(3n * 10n ** 13n);
  });

  it('rechaza tasas o bases inválidas', () => {
    expect(() => commissionFor(0n, 300)).toThrow();
    expect(() => commissionFor(100n, -1)).toThrow();
    expect(() => commissionFor(100n, 2001)).toThrow();
    expect(() => commissionFor(100n, 1.5)).toThrow();
  });
});

describe('margen de la casa (K11)', () => {
  it('Animalitos 50× sobre 70 → margen 28,57 % (RTP redondeado hacia arriba); 3 % es seguro', () => {
    const m = houseMarginBps(5000n, 70);
    expect(m).toBe(2857);
    expect(isCommissionRateSafe(300, m)).toBe(true);
  });

  it('Terminal directo 100× sobre 100 → margen 0; 3 % NO es seguro', () => {
    const m = houseMarginBps(10000n, 100);
    expect(m).toBe(0);
    expect(isCommissionRateSafe(300, m)).toBe(false);
  });

  it('Aproximación 20× con 2 vecinos sobre 100 → margen 60 %', () => {
    expect(houseMarginBps(2000n, 100, 2)).toBe(6000);
  });

  it('margen por modalidad de los juegos sembrados', () => {
    expect(modalityMarginBps('SYMBOLS', 'EXACT', 5000n, 70)).toBe(2857); // Animalitos (RTP redondeado arriba)
    expect(modalityMarginBps('DIGITS2', 'EXACT', 10000n, 0)).toBe(0); // Terminal directo
    expect(modalityMarginBps('DIGITS2', 'DUAL', 5000n, 0)).toBe(3000); // 50 + 2×10 = 70 %
    expect(modalityMarginBps('DIGITS3', 'EXACT', 60000n, 0)).toBe(4000); // 600/1000
    expect(modalityMarginBps('DIGITS3', 'TERMINAL', 6000n, 0)).toBe(4000);
    expect(modalityMarginBps('DIGITS3', 'LAST_DIGIT', 600n, 0)).toBe(4000);
    expect(modalityMarginBps('DIGITS3', 'FULL', 20000n, 0)).toBe(4400); // (200 + 9×20 + 90×2)/1000 = 56 %
    expect(modalityMarginBps('KINO', 'KINO5', 100000n, 0)).toBeGreaterThan(9000);
    expect(modalityMarginBps('SYMBOLS', 'COMBINADA', 5000n, 70)).toBeNull();
  });
});

describe('privacidad', () => {
  it('enmascara el nombre del referido', () => {
    expect(maskPlayerName('Ana María', 'pérez')).toBe('Ana P.');
    expect(maskPlayerName('Luis', '')).toBe('Luis');
  });
});

describe('retiros en Bs (Fase 3)', () => {
  it('convierte USDT a Bs a la tasa del día, hacia abajo', async () => {
    const { parseFxRate, usdtToVesCents, formatFxRate } = await import('./affiliate');
    const rate = parseFxRate('45,20');
    expect(rate).toBe(452000n);
    expect(formatFxRate(rate)).toBe('45,2000');
    expect(usdtToVesCents(5_000_000n, rate)).toBe(22600n); // 5 USDT → Bs 226,00
    expect(usdtToVesCents(1n, parseFxRate('36.5432'))).toBe(0n); // 1 micro-USDT no alcanza un céntimo
    expect(usdtToVesCents(1_234_567n, parseFxRate('36.5432'))).toBe(4511n); // 1,234567 × 36,5432 = 45,1150 → Bs 45,11
    expect(() => parseFxRate('0')).toThrow();
    expect(() => parseFxRate('45,123456')).toThrow();
    expect(() => parseFxRate('-3')).toThrow();
  });

  it('detecta saltos grandes de tasa', async () => {
    const { fxChangeBps, parseFxRate } = await import('./affiliate');
    expect(fxChangeBps(parseFxRate('40'), parseFxRate('44'))).toBe(1000);
    expect(fxChangeBps(parseFxRate('40'), parseFxRate('36'))).toBe(1000);
  });

  it('valida celulares de Pago Móvil y enmascara datos', async () => {
    const { isVeMobile, maskPhone, maskDocument } = await import('./affiliate');
    expect(isVeMobile('584141234567')).toBe(true);
    expect(isVeMobile('582121234567')).toBe(false); // fijo de Caracas
    expect(maskPhone('584141234567')).toBe('0414-***-4567');
    expect(maskDocument('V', '20111111')).toBe('V-20.***.111');
  });
});
