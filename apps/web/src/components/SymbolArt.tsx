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
}: {
  emoji?: string | null;
  number: string;
  numbers?: number[] | null;
  className?: string;
}) {
  if (numbers?.length) return <NumberBalls numbers={numbers} />;
  if (emoji) return <span className={className}>{emoji}</span>;
  return (
    <span
      className={`inline-flex min-w-[1.6em] items-center justify-center rounded-full bg-gradient-to-br from-oro-300 to-amber-400 px-[0.35em] py-[0.2em] text-[0.55em] leading-none font-extrabold tabular-nums text-selva-950 shadow-sm ring-1 ring-black/10 ${className}`}
    >
      {number}
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
