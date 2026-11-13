import { useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

/** Manuales de cada juego (propuestas documentales, NO OFICIALES), servidos desde apps/web/public/manuales. */
const MANUALS: { code: string; name: string; file: string }[] = [
  { code: 'MER-01', name: 'Triple Andino', file: 'MER-01-triple-andino.pdf' },
  { code: 'MER-02', name: 'Kino Teleférico', file: 'MER-02-kino-teleferico.pdf' },
  { code: 'MER-03', name: 'Frutas del Páramo', file: 'MER-03-frutas-del-paramo.pdf' },
  { code: 'MER-04', name: 'Terminal Nevado', file: 'MER-04-terminal-nevado.pdf' },
  { code: 'MER-05', name: 'Animalitos de Mérida', file: 'MER-05-animalitos-de-merida.pdf' },
  { code: 'MER-06', name: 'Centena Andina', file: 'MER-06-centena-andina.pdf' },
  { code: 'MER-07', name: 'Dupleta de Montaña', file: 'MER-07-dupleta-de-montana.pdf' },
  { code: 'MER-08', name: 'Cuatrifecta de Cumbres', file: 'MER-08-cuatrifecta-de-cumbres.pdf' },
  { code: 'MER-09', name: 'Cóndor Dorado', file: 'MER-09-condor-dorado.pdf' },
  { code: 'MER-10', name: 'Andes 5 Estrella', file: 'MER-10-andes-5-estrella.pdf' },
];

function Manuals() {
  return (
    <>
      <p className="text-white/70">Propuestas documentales, no oficiales: reglas, horarios y premios de cada juego (PDF).</p>
      <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {MANUALS.map((m) => (
          <li key={m.code}>
            <a
              href={`/manuales/${m.file}`}
              target="_blank"
              rel="noopener"
              className="group flex items-center gap-3 rounded-xl bg-white/[0.05] px-3 py-2.5 ring-1 ring-white/10 transition hover:bg-white/10 hover:ring-lima-500"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-600/90 text-[10px] font-extrabold text-white" aria-hidden="true">
                PDF
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-white group-hover:text-lima-400">{m.name}</span>
                <span className="block text-xs text-white/50">{m.code} · Manual del juego</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

const FAQ: { id: string; q: string; a: ReactNode }[] = [
  {
    id: 'manuales',
    q: '¿Dónde encuentro el manual de cada juego?',
    a: <Manuals />,
  },
  {
    id: 'que-es',
    q: '¿Qué es Fortuna.Bet?',
    a: <p>Es una aplicación de demostración de lotería. Los saldos no tienen valor real y su comercialización está prohibida.</p>,
  },
  {
    id: 'resultados',
    q: '¿Cómo se obtienen los resultados?',
    a: (
      <p>
        Cada resultado sale al azar de una semilla que se compromete antes del sorteo, así que nadie puede elegirlo. Puedes comprobar cualquier sorteo en{' '}
        <Link to="/resultados" className="font-semibold text-lima-400 hover:underline">
          Resultados
        </Link>
        .
      </p>
    ),
  },
  {
    id: 'horarios',
    q: '¿A qué hora son los sorteos?',
    a: <p>Cada juego tiene su propio horario (hora de Venezuela). Lo verás al elegir el juego en el inicio y en su manual.</p>,
  },
  {
    id: 'moneda',
    q: '¿En qué moneda puedo jugar?',
    a: (
      <p>
        En bolívares o en USDT. Tu saldo de cada moneda aparece en la{' '}
        <Link to="/billetera" className="font-semibold text-lima-400 hover:underline">
          Billetera
        </Link>
        .
      </p>
    ),
  },
  {
    id: 'edad',
    q: '¿Quién puede jugar?',
    a: <p>Solo mayores de 18 años. Juega con moderación.</p>,
  },
];

export function FaqPage() {
  const { hash } = useLocation();
  const target = hash.slice(1);
  // Al llegar desde el footer, empezar arriba (o en la pregunta enlazada).
  useEffect(() => {
    const el = target ? document.getElementById(target) : null;
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [target]);
  return (
    <div className="mx-auto max-w-6xl py-4">
      <h1 className="title-display text-4xl text-white sm:text-5xl">
        Preguntas <span className="text-lima-400">frecuentes</span>
      </h1>
      <ul className="mt-6 space-y-3">
        {FAQ.map((f, i) => (
          <li key={f.id} id={f.id} className="scroll-mt-24">
            <details open={target ? target === f.id : i === 0} className="group rounded-2xl bg-white/[0.05] ring-1 ring-white/10 open:bg-white/[0.07]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-lg font-semibold text-white">
                {f.q}
                <span className="text-2xl text-lima-400 transition group-open:rotate-45" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="px-5 pb-5 text-white/80">{f.a}</div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
