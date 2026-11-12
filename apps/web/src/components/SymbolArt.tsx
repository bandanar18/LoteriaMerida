/**
 * Dibujo del símbolo: el emoji del animal o la fruta; en juegos numéricos (Triple Andino), el número como bolita;
 * en Kino, la fila de bolitas con los números (7 extraídos o los elegidos en la jugada).
 * El tamaño sale de la fuente del contenedor (em), así sirve igual en listas y en tarjetas grandes.
 */
export function SymbolArt({
  emoji,
  number,
  numbers,
  className = '',
  star,
}: {
  emoji?: string | null;
  number: string;
  numbers?: number[] | null;
  className?: string;
  /** Andes 5 Estrella: estrella del resultado o de la jugada. */
  star?: number | null;
}) {
  if (numbers?.length)
    return star ? (
      <span className="inline-flex items-center gap-1">
        <NumberBalls numbers={numbers} />
        <StarBadge n={star} />
      </span>
    ) : (
      <NumberBalls numbers={numbers} />
    );
  if (emoji) return <span className={className}>{emoji}</span>;
  // Cóndor Dorado: «67-ROJO» (número + color), «ROJO» (solo color).
  // Dupleta de Montaña: «25-52» como dos bolitas, en el orden en que salen.
  const duo = number.match(/^(\d{2})-(\d{2})$/);
  if (duo) return <NumberBalls numbers={[Number(duo[1]), Number(duo[2])]} size="md" />;
  const condor = number.match(CONDOR_RE);
  if (condor) return <ColorBall number={condor[1]} color={condor[2]} className={className} />;
  return (
    <span
      className={`inline-flex min-w-[1.6em] items-center justify-center rounded-full bg-gradient-to-br from-oro-300 to-amber-400 px-[0.35em] py-[0.2em] text-[0.55em] leading-none font-extrabold tabular-nums text-selva-950 shadow-sm ring-1 ring-black/10 ${className}`}
    >
      {number}
    </span>
  );
}

/** Estrella dorada con su número (Andes 5 Estrella). */
export function StarBadge({ n, hit }: { n: number; hit?: boolean | null }) {
  return (
    <span
      role="img"
      aria-label={`Estrella ${n}`}
      className={`relative inline-flex h-[1.5rem] w-[1.5rem] shrink-0 items-center justify-center align-middle ${hit === false ? 'opacity-50 grayscale' : ''}`}
    >
      <span className="absolute inset-0 text-[1.5rem] leading-none" aria-hidden="true">⭐</span>
      <span className="relative mt-[2px] text-[10px] font-extrabold text-amber-950">{n}</span>
    </span>
  );
}

const CONDOR_RE = /^(?:(\d{2})-)?(ROJO|AZUL|VERDE|AMARILLO)$/;

/** Colores de Cóndor Dorado: fondo de la bolita y su nombre para lectores de pantalla. */
export const CONDOR_BALL: Record<string, { cls: string; name: string }> = {
  ROJO: { cls: 'from-red-500 to-red-700 text-white', name: 'Rojo' },
  AZUL: { cls: 'from-blue-500 to-blue-700 text-white', name: 'Azul' },
  VERDE: { cls: 'from-green-500 to-green-700 text-white', name: 'Verde' },
  AMARILLO: { cls: 'from-yellow-300 to-amber-400 text-amber-950', name: 'Amarillo' },
};

/** Bolita de color con su número (o sin número, para «solo color»). Tamaño en em, como el resto de dibujos. */
export function ColorBall({ number, color, className = '' }: { number?: string; color: string; className?: string }) {
  const c = CONDOR_BALL[color] ?? CONDOR_BALL.ROJO;
  return (
    <span
      role="img"
      aria-label={number ? `${number} ${c.name}` : c.name}
      className={`inline-flex h-[1.1em] w-[1.1em] shrink-0 items-center justify-center rounded-full bg-gradient-to-br align-middle leading-none font-extrabold tabular-nums shadow-[inset_0_-2px_4px_rgba(0,0,0,.25)] ring-2 ring-white/80 ${c.cls} ${className}`}
    >
      <span className="text-[0.48em]">{number ?? ''}</span>
    </span>
  );
}

const BALL_COLORS = ['from-sky-400 to-sky-600', 'from-rose-400 to-rose-600', 'from-amber-300 to-amber-500', 'from-emerald-400 to-emerald-600', 'from-violet-400 to-violet-600'];

/** Bolitas numeradas (Kino). `hits` resalta las que coinciden con el resultado. */
export function NumberBalls({ numbers, hits, size = 'sm' }: { numbers: number[]; hits?: number[] | null; size?: 'sm' | 'md' }) {
  const box = size === 'md' ? 'h-8 w-8 text-sm' : 'h-[1.35rem] w-[1.35rem] text-[10px]';
  const hit = new Set(hits ?? []);
  return (
    <span className="inline-flex flex-wrap items-center justify-center gap-0.5 align-middle">
      {numbers.map((n, i) => (
        <span
          key={`${n}-${i}`}
          className={`inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-extrabold leading-none tabular-nums text-white shadow-sm ring-1 ring-black/10 ${box} ${
            hits && !hit.has(n) ? 'from-slate-300 to-slate-400 opacity-70' : BALL_COLORS[n % BALL_COLORS.length]
          }`}
        >
          {String(n).padStart(2, '0')}
        </span>
      ))}
    </span>
  );
}

/** El nombre solo si aporta algo (en Triple Andino y Kino el nombre es el mismo número). */
export const symbolName = (number: string, name?: string | null) => (name && name !== number ? name : '');
