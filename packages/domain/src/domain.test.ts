import { describe, expect, it } from 'vitest';
import {
  checkModality,
  digitPermutations,
  pairParity,
  PARITY_SYMBOL,
  drawStar,
  hasStar,
  DUPLETA_SYMBOLS,
  DupletaPayouts,
  CUATRIFECTA_NUMBERS,
  pickWins,
  pickWinProbability,
  pickMaxWinners,
  pairKeys,
  CONDOR_SYMBOLS,
  ColorPayouts,
  affectedResults,
  allResults,
  MERIDA_ANIMALS,
  PARAMO_FRUITS,
  TerminalPayouts,
  TERMINAL_NUMBERS,
  kinoSubsetsPerDraw,
  kinoWinProbability,
  kinoSize,
  normalizeKinoSelection,
  kinoWins,
  fairSample,
  KINO_NUMBERS,
  prizeFactor,
  TRIPLE_NUMBERS,
  TriplePayouts,
  playMatches,
  playedKey,
  potentialWin,
  rtpBps,
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

describe('Animalitos de Mérida (MER-05)', () => {
  it('catálogo 00–69: 70 códigos únicos, sin «0» (v2.0)', () => {
    const nums = MERIDA_ANIMALS.map((a) => a.number);
    expect(nums).toHaveLength(70);
    expect(new Set(nums).size).toBe(70);
    expect(nums).not.toContain('0');
    expect(nums).toEqual(Array.from({ length: 70 }, (_, i) => String(i).padStart(2, '0')));
    expect(new Set(MERIDA_ANIMALS.map((a) => a.name)).size).toBe(70);
    expect(new Set(MERIDA_ANIMALS.map((a) => a.emoji)).size).toBe(70);
  });

  it('conserva las asociaciones de la FUR', () => {
    const byNum = new Map(MERIDA_ANIMALS.map((a) => [a.number, a.name]));
    expect(byNum.get('00')).toBe('Oso Frontino');
    expect(byNum.get('07')).toBe('Venado');
    expect(byNum.get('17')).toBe('Colibrí');
    expect(byNum.get('24')).toBe('Cunaguaro');
    expect(byNum.get('36')).toBe('Cóndor');
  });

  it('solo vende modalidades activas y con la cantidad correcta de animales', () => {
    const exact = { code: 'EXACT', status: 'ACTIVE', minSelections: 1, maxSelections: 1 } as const;
    const combinada = { code: 'COMBINADA', status: 'PENDING_APPROVAL', minSelections: 2, maxSelections: 4 } as const;
    expect(checkModality(exact, 1)).toBeNull();
    expect(checkModality(exact, 2)).toEqual({ code: 'BAD_SELECTION_COUNT', min: 1, max: 1 });
    expect(checkModality(combinada, 2)).toEqual({ code: 'MODALITY_NOT_ACTIVE', modality: 'COMBINADA' });
  });

  it('RTP: exacto 30× = 81,08 %; las lecturas de 50×/20× de la FUR no cuadran', () => {
    expect(rtpBps(3000n, 1n, 37n)).toBe(8108n);
    expect(rtpBps(2500n, 1n, 37n)).toBe(6756n); // MER-05 v1.1: exacto 25× → 67,56 %
    expect(rtpBps(5000n, 1n, 70n)).toBe(7142n); // MER-05 v2.0: 70 animales, exacto 50× → 71,42 %
    expect(rtpBps(5000n, 2n, 37n)).toBe(27027n); // combinada "cualquiera de 2": 270 %
    expect(rtpBps(2000n, 5n, 37n)).toBe(27027n); // múltiple "cualquiera de 5": 270 %
    expect(rtpBps(5000n, 1n, 1369n)).toBe(365n); // "todos" en 2 sorteos: 3,65 %
  });
});

describe('Frutas del Páramo (MER-03)', () => {
  it('catálogo 00–69: 70 frutas con número y nombre únicos', () => {
    const nums = PARAMO_FRUITS.map((f) => f.number);
    expect(nums).toEqual(Array.from({ length: 70 }, (_, i) => String(i).padStart(2, '0')));
    expect(new Set(PARAMO_FRUITS.map((f) => f.name)).size).toBe(70);
    expect(PARAMO_FRUITS.every((f) => f.emoji.length > 0)).toBe(true);
  });

  it('empieza con las frutas de la ficha FUR', () => {
    expect(PARAMO_FRUITS.slice(0, 6).map((f) => f.name)).toEqual(['Mora', 'Durazno', 'Uva', 'Fresa', 'Manzana', 'Pera']);
  });

  it('RTP: fruta exacta 40× con 70 frutas = 57,14 %', () => {
    expect(rtpBps(4000n, 1n, 70n)).toBe(5714n);
  });
});

describe('Triple Andino (MER-01)', () => {
  it('catálogo 000–999', () => {
    expect(TRIPLE_NUMBERS).toHaveLength(1000);
    expect(TRIPLE_NUMBERS[0].number).toBe('000');
    expect(TRIPLE_NUMBERS[718].number).toBe('718');
    expect(TRIPLE_NUMBERS[999].number).toBe('999');
  });

  it('si sale 718: triple 718, terminal 18 y última cifra 8 ganan; son apuestas distintas', () => {
    expect(playMatches('EXACT', '718', '718')).toBe(true);
    expect(playMatches('EXACT', '218', '718')).toBe(false);
    expect(playMatches('TERMINAL', '218', '718')).toBe(true);
    expect(playMatches('TERMINAL', '781', '718')).toBe(false);
    expect(playMatches('LAST_DIGIT', '008', '718')).toBe(true);
    expect(playMatches('LAST_DIGIT', '719', '718')).toBe(false);
    expect(playedKey('TERMINAL', '718')).toBe('18');
    expect(playedKey('LAST_DIGIT', '718')).toBe('8');
  });

  it('Bs. 10 en 718: 600× = 6.000, 60× = 600, 6× = 60 (Cuadro III)', () => {
    expect(potentialWin(1000n, 60000n)).toBe(600000n);
    expect(potentialWin(1000n, 6000n)).toBe(60000n);
    expect(potentialWin(1000n, 600n)).toBe(6000n);
  });

  it('RTP de las tres modalidades = 60 %', () => {
    expect(rtpBps(60000n, 1n, 1000n)).toBe(6000n);
    expect(rtpBps(6000n, 1n, 100n)).toBe(6000n);
    expect(rtpBps(600n, 1n, 10n)).toBe(6000n);
  });

  it('pasivo por resultado suma las tres modalidades', () => {
    const p = new TriplePayouts().add('EXACT', '718', 600000n).add('TERMINAL', '218', 60000n).add('LAST_DIGIT', '008', 6000n);
    expect(p.payout('718')).toBe(666000n);
    expect(p.payout('118')).toBe(66000n);
    expect(p.payout('998')).toBe(6000n);
    expect(p.payout('717')).toBe(0n);
    expect(p.worst()).toEqual({ result: '718', payout: 666000n });
    expect(TriplePayouts.affected('EXACT', '718')).toEqual(['718']);
    expect(TriplePayouts.affected('TERMINAL', '718')).toHaveLength(10);
    expect(TriplePayouts.affected('TERMINAL', '718')[3]).toBe('318');
    expect(TriplePayouts.affected('LAST_DIGIT', '718')).toHaveLength(100);
    expect(TriplePayouts.affected('LAST_DIGIT', '718')[42]).toBe('428');
  });
});

describe('Jugadas repetidas', () => {
  it('mismo número y sorteo en dos modalidades no es duplicado; en la misma sí', () => {
    const lim = { minPlay: 1n, maxPlay: 1000n, maxTicket: 10000n };
    const a = { drawId: 'd', symbolId: '718', amount: 10n, modalityId: 'EXACT' };
    expect(validatePlays([a, { ...a, modalityId: 'TERMINAL' }], lim)).toBeNull();
    expect(validatePlays([a, { ...a }], lim)?.code).toBe('DUPLICATE_PLAY');
  });
});

describe('Triple Andino · Las 3 (FULL)', () => {
  it('participa en las tres y cobra solo el mayor premio', () => {
    // Bs. 30 a 718 con 200× → exacto 6.000, terminal 600, última cifra 60 (como Bs. 10 en cada una, sin sumar).
    expect(prizeFactor('FULL', '718', '718', 20000n)).toBe(20000n);
    expect(prizeFactor('FULL', '718', '218', 20000n)).toBe(2000n);
    expect(prizeFactor('FULL', '718', '998', 20000n)).toBe(200n);
    expect(prizeFactor('FULL', '718', '717', 20000n)).toBe(0n);
    expect(applyMultiplier(3000n, prizeFactor('FULL', '718', '718', 20000n))).toBe(600000n);
    expect(prizeFactor('TERMINAL', '018', '718', 6000n)).toBe(6000n);
    expect(playMatches('FULL', '718', '998')).toBe(true);
    expect(playedKey('FULL', '718')).toBe('718');
  });

  it('retorno: 200 × (1/1000 + 1/10 · 9/1000 + 1/100 · 90/1000) = 56 %', () => {
    let paid = 0n;
    for (let i = 0; i < 1000; i++) paid += prizeFactor('FULL', '718', String(i).padStart(3, '0'), 20000n);
    expect(paid).toBe(20000n + 9n * 2000n + 90n * 200n); // 56.000 sobre 100.000 apostado en 1.000 sorteos
  });

  it('el tope por resultado cuenta solo el premio mayor', () => {
    const p = new TriplePayouts().add('FULL', '718', 600000n);
    expect(p.payout('718')).toBe(600000n);
    expect(p.payout('218')).toBe(60000n);
    expect(p.payout('998')).toBe(6000n);
    expect(p.payout('717')).toBe(0n);
    expect(TriplePayouts.affected('FULL', '718')).toHaveLength(100);
  });
});

describe('Kino Teleférico (MER-02)', () => {
  it('catálogo 01–40', () => {
    expect(KINO_NUMBERS).toHaveLength(40);
    expect(KINO_NUMBERS[0].number).toBe('01');
    expect(KINO_NUMBERS[39].number).toBe('40');
  });

  it('extracción provably fair: 7 números distintos, reproducible', () => {
    const seed = 'ab'.repeat(32);
    const a = fairSample(seed, 'draw-1', 40, 7);
    expect(a).toHaveLength(7);
    expect(new Set(a).size).toBe(7);
    expect(a.every((x) => x >= 0 && x < 40)).toBe(true);
    expect(fairSample(seed, 'draw-1', 40, 7)).toEqual(a);
    expect(fairSample(seed, 'draw-2', 40, 7)).not.toEqual(a);
  });

  it('ejemplo del manual: Kino 5 02-07-13-22-24 acierta con 02-07-13-22-24-28-35', () => {
    const drawn = [2, 7, 13, 22, 24, 28, 35];
    expect(kinoWins([2, 7, 13, 22, 24], drawn)).toBe(true);
    expect(kinoWins([2, 7, 13, 22, 25], drawn)).toBe(false);
    expect(kinoWins([2, 7, 13, 22, 24, 28, 35], drawn)).toBe(true);
    expect(potentialWin(500n, 100000n)).toBe(500000n); // Bs. 5 × 1.000 = Bs. 5.000
  });

  it('valida la selección', () => {
    expect(normalizeKinoSelection('KINO5', [24, 2, 13, 7, 22])).toEqual({ ok: true, selection: [2, 7, 13, 22, 24] });
    expect(normalizeKinoSelection('KINO5', [1, 2, 3, 4]).ok).toBe(false);
    expect(normalizeKinoSelection('KINO5', [1, 2, 3, 4, 4]).ok).toBe(false);
    expect(normalizeKinoSelection('KINO6', [1, 2, 3, 4, 5, 41]).ok).toBe(false);
    expect(kinoSize('KINO7')).toBe(7);
  });

  it('probabilidades y retorno con la tabla del manual (1.000× / 5.000× / 20.000×)', () => {
    expect(kinoWinProbability(5)).toBeCloseTo(595 / 18643560, 12);
    expect(kinoWinProbability(6)).toBeCloseTo(34 / 18643560, 12);
    expect(kinoWinProbability(7)).toBeCloseTo(1 / 18643560, 14);
    expect(1000 * kinoWinProbability(5)).toBeCloseTo(0.0319, 3);
    expect(kinoSubsetsPerDraw(5)).toBe(21);
    expect(kinoSubsetsPerDraw(6)).toBe(7);
  });

  it('una misma selección no se repite en el ticket; otra selección del mismo número menor sí', () => {
    const lim = { minPlay: 1n, maxPlay: 1000n, maxTicket: 10000n };
    const a = { drawId: 'd', symbolId: '02', amount: 10n, modalityId: 'K5', selection: [2, 7, 13, 22, 24] };
    expect(validatePlays([a, { ...a, selection: [2, 7, 13, 22, 25] }], lim)).toBeNull();
    expect(validatePlays([a, { ...a }], lim)?.code).toBe('DUPLICATE_PLAY');
  });
});

describe('Terminal Nevado (MER-04)', () => {
  it('catálogo 00–99', () => {
    expect(TERMINAL_NUMBERS).toHaveLength(100);
    expect(TERMINAL_NUMBERS[18].number).toBe('18');
  });

  it('ejemplo del manual: 18 directo con Bs. 10 → Bs. 1.000; 17 y 19 aciertan la aproximación', () => {
    expect(prizeFactor('EXACT', '18', '18', 10000n)).toBe(10000n);
    expect(applyMultiplier(1000n, 10000n)).toBe(100000n);
    expect(prizeFactor('APPROX', '17', '18', 2000n)).toBe(2000n);
    expect(prizeFactor('APPROX', '19', '18', 2000n)).toBe(2000n);
    expect(prizeFactor('APPROX', '18', '18', 2000n)).toBe(0n);
    expect(prizeFactor('APPROX', '20', '18', 2000n)).toBe(0n);
  });

  it('aproximación sin circularidad: 00 y 99 no son vecinos', () => {
    expect(prizeFactor('APPROX', '99', '00', 2000n)).toBe(0n);
    expect(TerminalPayouts.affected('APPROX', '00')).toEqual(['01']);
    expect(TerminalPayouts.affected('APPROX', '17')).toEqual(['16', '18']);
  });

  it('pasivo por resultado suma directo y aproximaciones', () => {
    const p = new TerminalPayouts().add('EXACT', '18', 100000n).add('APPROX', '17', 20000n).add('APPROX', '19', 20000n);
    expect(p.payout('18')).toBe(140000n);
    expect(p.payout('16')).toBe(20000n);
    expect(p.payout('17')).toBe(0n);
  });

  it('retorno: directo 100× = 100 %, aproximación 20× ≈ 40 %', () => {
    expect(rtpBps(10000n, 1n, 100n)).toBe(10000n);
    expect(rtpBps(2000n, 2n, 100n)).toBe(4000n);
  });
});

describe('Terminal Nevado · Las 2 (DUAL)', () => {
  it('un número juega directo y aproximación; cobra un solo premio', () => {
    // Bs. 10 a 18 con 50×: sale 18 → Bs. 500; sale 17 o 19 → Bs. 100 (como Bs. 5 en cada modalidad).
    expect(applyMultiplier(1000n, prizeFactor('DUAL', '18', '18', 5000n))).toBe(50000n);
    expect(applyMultiplier(1000n, prizeFactor('DUAL', '18', '17', 5000n))).toBe(10000n);
    expect(applyMultiplier(1000n, prizeFactor('DUAL', '18', '19', 5000n))).toBe(10000n);
    expect(prizeFactor('DUAL', '18', '20', 5000n)).toBe(0n);
    expect(prizeFactor('DUAL', '00', '99', 5000n)).toBe(0n);
  });

  it('retorno 70 % y pasivo por resultado', () => {
    let paid = 0n;
    for (let i = 0; i < 100; i++) paid += prizeFactor('DUAL', '18', String(i).padStart(2, '0'), 5000n);
    expect(paid).toBe(5000n + 2n * 1000n); // 70 sobre 100 apostado en 100 sorteos
    const p = new TerminalPayouts().add('DUAL', '18', 50000n);
    expect(p.payout('18')).toBe(50000n);
    expect(p.payout('19')).toBe(10000n);
    expect(TerminalPayouts.affected('DUAL', '18')).toEqual(['18', '17', '19']);
  });
});

describe('Cóndor Dorado (MER-09)', () => {
  it('400 resultados únicos: 100 números × 4 colores', () => {
    expect(CONDOR_SYMBOLS).toHaveLength(400);
    expect(new Set(CONDOR_SYMBOLS.map((s) => s.number)).size).toBe(400);
    expect(CONDOR_SYMBOLS[268]).toEqual({ number: '67-ROJO', name: '67 Rojo', emoji: '' });
    expect(allResults('COLOR')).toHaveLength(400);
  });

  it('cada modalidad gana solo con su condición', () => {
    expect(prizeFactor('EXACT', '67-ROJO', '67-ROJO', 50000n)).toBe(50000n);
    expect(prizeFactor('EXACT', '67-ROJO', '67-AZUL', 50000n)).toBe(0n);
    expect(prizeFactor('NUMBER', '67-ROJO', '67-VERDE', 5000n)).toBe(5000n);
    expect(prizeFactor('NUMBER', '67-ROJO', '68-ROJO', 5000n)).toBe(0n);
    expect(prizeFactor('COLOR', '00-ROJO', '67-ROJO', 500n)).toBe(500n);
    expect(prizeFactor('COLOR', '00-ROJO', '67-AZUL', 500n)).toBe(0n);
    expect(playedKey('NUMBER', '67-ROJO')).toBe('67');
    expect(playedKey('COLOR', '00-AMARILLO')).toBe('Amarillo');
  });

  it('el pasivo por resultado suma las tres modalidades', () => {
    expect(ColorPayouts.affected('NUMBER', '67-ROJO')).toEqual(['67-ROJO', '67-AZUL', '67-VERDE', '67-AMARILLO']);
    expect(affectedResults('COLOR', 'COLOR', '00-VERDE')).toHaveLength(100);
    const p = new ColorPayouts().add('EXACT', '67-ROJO', 5000n).add('NUMBER', '67-ROJO', 500n).add('COLOR', '00-ROJO', 50n);
    expect(p.payout('67-ROJO')).toBe(5550n);
    expect(p.payout('67-AZUL')).toBe(500n);
    expect(p.payout('12-ROJO')).toBe(50n);
    expect(p.payout('12-AZUL')).toBe(0n);
  });

  it('RTP del manual: número + color y solo color devuelven 125 %, solo número 50 %', () => {
    expect(rtpBps(50000n, 1n, 400n)).toBe(12500n);
    expect(rtpBps(5000n, 4n, 400n)).toBe(5000n);
    expect(rtpBps(500n, 100n, 400n)).toBe(12500n);
  });
});

describe('Centena Andina (MER-06)', () => {
  it('Aproximación = las dos últimas cifras en orden; Par andino = en cualquier orden', () => {
    expect(prizeFactor('EXACT', '009', '009', 20000n)).toBe(20000n);
    expect(prizeFactor('TERMINAL', '009', '209', 4000n)).toBe(4000n);
    expect(prizeFactor('TERMINAL', '009', '290', 4000n)).toBe(0n);
    expect(prizeFactor('PAIR', '090', '509', 2000n)).toBe(2000n);
    expect(prizeFactor('PAIR', '090', '590', 2000n)).toBe(2000n);
    expect(prizeFactor('PAIR', '090', '599', 2000n)).toBe(0n);
    expect(pairKeys('477')).toEqual(['77']);
    expect(playedKey('PAIR', '090')).toBe('90');
  });

  it('Par andino toca 20 resultados (10 si las cifras son iguales) y suma en el pasivo', () => {
    expect(TriplePayouts.affected('PAIR', '090')).toHaveLength(20);
    expect(TriplePayouts.affected('PAIR', '077')).toHaveLength(10);
    const p = new TriplePayouts().add('PAIR', '090', 200n).add('EXACT', '009', 2000n);
    expect(p.payout('009')).toBe(2200n);
    expect(p.payout('190')).toBe(200n);
    expect(p.payout('199')).toBe(0n);
  });
});

describe('Andes 5 Estrella (MER-10)', () => {
  const drawn = [3, 12, 21, 34, 40];
  it('5 exactos, 4 aciertos y 3 aciertos piden exactamente esa cantidad', () => {
    expect(pickWins('MATCH5', [3, 12, 21, 34, 40], drawn)).toBe(true);
    expect(pickWins('MATCH4', [3, 12, 21, 34, 40], drawn)).toBe(false);
    expect(pickWins('MATCH4', [3, 12, 21, 34, 38], drawn)).toBe(true);
    expect(pickWins('MATCH3', [3, 12, 21, 7, 29], drawn)).toBe(true);
    expect(pickWins('MATCH3', [3, 12, 21, 34, 29], drawn)).toBe(false);
    expect(pickWins('KINO5', [3, 12, 21, 34, 40], [...drawn, 1, 2])).toBe(true);
  });
  it('probabilidades exactas sobre C(40,5) = 658.008', () => {
    expect(pickWinProbability('MATCH5', 5) * 658008).toBeCloseTo(1);
    expect(pickWinProbability('MATCH4', 5) * 658008).toBeCloseTo(175);
    expect(pickWinProbability('MATCH3', 5) * 658008).toBeCloseTo(5950);
    expect(pickWinProbability('KINO5', 7)).toBeCloseTo(kinoWinProbability(5));
    expect(pickMaxWinners('MATCH4', 5)).toBe(175);
    expect(pickMaxWinners('KINO5', 7)).toBe(21);
  });
});

describe('Cuatrifecta de Cumbres (MER-08)', () => {
  it('10.000 resultados de 0000 a 9999', () => {
    expect(CUATRIFECTA_NUMBERS).toHaveLength(10000);
    expect(CUATRIFECTA_NUMBERS[1234].number).toBe('1234');
    expect(allResults('DIGITS4')).toHaveLength(10000);
  });
  it('exacta y aproximación (vecinos de 4 cifras, sin dar la vuelta)', () => {
    expect(prizeFactor('EXACT', '1234', '1234', 200000n)).toBe(200000n);
    expect(prizeFactor('EXACT', '1234', '1235', 200000n)).toBe(0n);
    expect(prizeFactor('APPROX', '1234', '1233', 10000n)).toBe(10000n);
    expect(prizeFactor('APPROX', '1234', '1236', 10000n)).toBe(0n);
    expect(affectedResults('DIGITS4', 'APPROX', '1234')).toEqual(['1233', '1235']);
    expect(affectedResults('DIGITS4', 'APPROX', '0000')).toEqual(['0001']);
    expect(affectedResults('DIGITS4', 'APPROX', '9999')).toEqual(['9998']);
    expect(affectedResults('DIGITS2', 'APPROX', '99')).toEqual(['98']);
  });
});

describe('Dupleta de Montaña (MER-07)', () => {
  it('9.900 parejas ordenadas de números distintos', () => {
    expect(DUPLETA_SYMBOLS).toHaveLength(9900);
    expect(DUPLETA_SYMBOLS.some((s) => s.number === '25-25')).toBe(false);
    expect(allResults('DUO')).toHaveLength(9900);
  });
  it('exacta gana con 25-52; invertida con 52-25', () => {
    expect(prizeFactor('EXACT', '25-52', '25-52', 15000n)).toBe(15000n);
    expect(prizeFactor('EXACT', '25-52', '52-25', 15000n)).toBe(0n);
    expect(prizeFactor('REVERSED', '25-52', '52-25', 7500n)).toBe(7500n);
    expect(prizeFactor('REVERSED', '25-52', '25-52', 7500n)).toBe(0n);
    const p = new DupletaPayouts().add('EXACT', '25-52', 1500n).add('REVERSED', '52-25', 750n);
    expect(p.payout('25-52')).toBe(2250n);
    expect(affectedResults('DUO', 'REVERSED', '25-52')).toEqual(['52-25']);
  });
});

describe('Modalidades completadas', () => {
  it('Cuatrifecta «Terminal 4 cifras»: las cuatro cifras en cualquier orden', () => {
    expect(prizeFactor('BOX', '1234', '4321', 30000n)).toBe(30000n);
    expect(prizeFactor('BOX', '1234', '1235', 30000n)).toBe(0n);
    expect(digitPermutations('1234')).toHaveLength(24);
    expect(digitPermutations('1123')).toHaveLength(12);
    expect(digitPermutations('7777')).toEqual(['7777']);
    expect(affectedResults('DIGITS4', 'BOX', '1123')).toHaveLength(12);
  });
  it('Dupleta «Doble paridad»: ambos pares o ambos impares', () => {
    expect(pairParity('24-86')).toBe('EVEN');
    expect(pairParity('25-53')).toBe('ODD');
    expect(pairParity('25-52')).toBe('MIXED');
    expect(prizeFactor('PARITY', PARITY_SYMBOL.EVEN, '24-86', 300n)).toBe(300n);
    expect(prizeFactor('PARITY', PARITY_SYMBOL.EVEN, '25-52', 300n)).toBe(0n);
    expect(prizeFactor('PARITY', PARITY_SYMBOL.ODD, '25-53', 300n)).toBe(300n);
    expect(affectedResults('DUO', 'PARITY', PARITY_SYMBOL.EVEN)).toHaveLength(2450);
    expect(playedKey('PARITY', PARITY_SYMBOL.ODD)).toBe('Ambos impares');
  });
  it('Andes 5 Estrella con estrella: además debe acertar la estrella; RTP igual que sin ella', () => {
    const drawn = [3, 12, 21, 34, 40];
    expect(hasStar('MATCH5S')).toBe(true);
    expect(pickWins('MATCH5S', drawn, drawn, 5, 5)).toBe(true);
    expect(pickWins('MATCH5S', drawn, drawn, 4, 5)).toBe(false);
    expect(pickWins('MATCH4S', [3, 12, 21, 34, 38], drawn, 2, 2)).toBe(true);
    expect(pickWinProbability('MATCH4S', 5) * 5).toBeCloseTo(pickWinProbability('MATCH4', 5));
    const s = drawStar('00'.repeat(32), 'draw-1');
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(5);
    expect(drawStar('00'.repeat(32), 'draw-1')).toBe(s);
  });
});
