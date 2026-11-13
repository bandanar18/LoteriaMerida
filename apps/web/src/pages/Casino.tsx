import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  CASINO_CATEGORIES, CASINO_GAMES, casinoLaunchUrl, casinoThumbnail, findCasinoGame, normalizeCasinoSearch, type CasinoGame,
} from '../lib/casino';
import './casino.css';

function CasinoNote() {
  return (
    <p className="casino-note">
      <span aria-hidden="true">ⓘ</span>
      <span>Juega gratis con fichas del proveedor. No se usa el saldo de Fortuna.Bet. Los juegos pueden mostrar publicidad y estar en otro idioma.</span>
    </p>
  );
}

function GameCard({ game }: { game: CasinoGame }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <Link to={`/casino/${game.slug}`} className="casino-game" style={{ '--game-accent': game.accent } as CSSProperties} aria-label={`Jugar ${game.name}`}>
      <div className="casino-game-art">
        {imageFailed ? <span className="casino-image-fallback" aria-hidden="true">{game.category === 'slots' ? '777' : game.category === 'ruleta' ? '◉' : '♠'}</span> : (
          <img src={casinoThumbnail(game)} alt="" loading="lazy" width="512" height="384" onError={() => setImageFailed(true)} />
        )}
        <span className="casino-game-badge">{game.badge}</span>
        <span className="casino-game-play" aria-hidden="true">▶</span>
        <span className="casino-game-free">Jugar gratis <span aria-hidden="true">↗</span></span>
      </div>
      <div className="casino-game-copy">
        <span className="casino-provider">INLOGIC · GAMEMONETIZE</span>
        <h2>{game.name}</h2>
        <p>{game.description}</p>
      </div>
    </Link>
  );
}

function CasinoLobby() {
  const [params, setParams] = useSearchParams();
  const category = CASINO_CATEGORIES.find(c => c.id === params.get('categoria'))?.id ?? 'todos';
  const search = params.get('buscar') ?? '';
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'todos') next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const games = CASINO_GAMES.filter(game => (category === 'todos' || game.category === category)
    && normalizeCasinoSearch(`${game.name} ${game.description} ${game.badge}`).includes(normalizeCasinoSearch(search.trim())));
  return (
    <div className="casino-page">
      <section className="casino-hero" aria-labelledby="casino-title">
        <div className="casino-hero-copy">
          <span className="casino-eyebrow"><i /> CASINO · FREE PLAY</span>
          <h1 id="casino-title">Tu próxima jugada<br /><em>empieza aquí.</em></h1>
          <p>Frutas, rodillos y cartas sobre la mesa. Descubre los clásicos del casino, a tu ritmo y con fichas de prueba.</p>
          <a href="#casino-juegos" className="casino-primary">Explorar juegos <span aria-hidden="true">↓</span></a>
        </div>
        <Link to="/casino/fruit-slot-machine" className="casino-feature" aria-label="Jugar Fruit Slot Machine, slot de frutas">
          <img src={casinoThumbnail(CASINO_GAMES[0])} alt="Rodillos del juego Fruit Slot Machine" width="512" height="384" />
          <div className="casino-feature-copy"><span>EL CLÁSICO DE FRUTAS</span><strong>Gira. Combina.<br />Diviértete.</strong><span className="casino-feature-cta">Fruit Slot Machine <b aria-hidden="true">▶</b></span></div>
        </Link>
      </section>
      <CasinoNote />
      <section id="casino-juegos" aria-labelledby="casino-games-title" className="casino-catalog">
        <div className="casino-catalog-heading">
          <div><span className="casino-eyebrow">ENCUENTRA TU FAVORITO</span><h2 id="casino-games-title">Nuestra selección</h2></div>
          <label className="casino-search"><span aria-hidden="true">⌕</span><span className="sr-only">Buscar juegos de casino</span><input type="search" value={search} onChange={event => update('buscar', event.target.value)} placeholder="Buscar un juego…" /></label>
        </div>
        <div className="casino-categories" role="group" aria-label="Categorías de casino">
          {CASINO_CATEGORIES.map(item => <button type="button" key={item.id} aria-pressed={category === item.id} onClick={() => update('categoria', item.id)}><span aria-hidden="true">{item.symbol}</span>{item.label}</button>)}
        </div>
        <p className="casino-result-count" role="status">{games.length} {games.length === 1 ? 'juego disponible' : 'juegos disponibles'}</p>
        {games.length ? <div className="casino-grid">{games.map(game => <GameCard game={game} key={game.slug} />)}</div> : (
          <div className="casino-empty"><span aria-hidden="true">♣</span><h3>No encontramos ese juego</h3><p>Prueba con otro nombre o explora todas las categorías.</p><button type="button" className="casino-primary" onClick={() => setParams({})}>Ver todos los juegos</button></div>
        )}
      </section>
      <p className="casino-attribution">Juegos de Inlogic Software, distribuidos por <a href="https://gamemonetize.com/faq" target="_blank" rel="noopener noreferrer">GameMonetize ↗</a>. La disponibilidad, las fichas y el progreso dependen de cada juego.</p>
    </div>
  );
}

function CasinoPlayer({ game }: { game: CasinoGame }) {
  const [attempt, setAttempt] = useState(0);
  const [mirror, setMirror] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [fullscreenMessage, setFullscreenMessage] = useState('');
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLoaded(false); setSlow(false);
    const timer = setTimeout(() => setSlow(true), 18000);
    return () => clearTimeout(timer);
  }, [attempt, mirror]);
  const fullscreen = async () => {
    try {
      if (!container.current?.requestFullscreen) throw new Error('unsupported');
      await container.current.requestFullscreen();
    } catch {
      setFullscreenMessage('Tu navegador no permite pantalla completa aquí. Puedes abrir el juego en otra pestaña.');
    }
  };
  return (
    <div className="casino-page casino-player-page">
      <Link to="/casino" className="casino-back">← Volver al casino</Link>
      <div className="casino-player-heading"><div><span className="casino-eyebrow">CASINO · {game.badge}</span><h1>{game.name}</h1><p>Inlogic Software · GameMonetize</p></div><span className="casino-free-tag">FICHAS DE PRUEBA</span></div>
      <CasinoNote />
      <div className="casino-player-frame" ref={container}>
        <div className="casino-player-toolbar"><strong>{game.name}</strong><button type="button" onClick={fullscreen}>⛶ <span>Pantalla completa</span></button></div>
        <div className="casino-screen">
          {!loaded && <div className="casino-loading" role="status"><span className="casino-spinner" /><strong>{slow ? 'La conexión está tardando…' : 'Abriendo el juego…'}</strong><p>{slow ? 'Puedes reintentar o usar el servidor alternativo debajo.' : 'Conectando con GameMonetize'}</p></div>}
          <iframe
            key={`${attempt}-${mirror}`}
            src={casinoLaunchUrl(game, mirror)}
            title={`Jugar ${game.name}`}
            allow="autoplay; fullscreen; gamepad"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-orientation-lock"
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={() => setLoaded(true)}
            onError={() => { setLoaded(false); setSlow(true); }}
          />
        </div>
      </div>
      {fullscreenMessage && <p className="casino-help-message" role="status">{fullscreenMessage}</p>}
      <div className="casino-player-help"><div><strong>¿El juego no aparece?</strong><p>Puede tardar en cargar o verse afectado por bloqueadores de anuncios.</p></div><div className="casino-player-actions"><button type="button" onClick={() => { setLoaded(false); setAttempt(value => value + 1); }}>Reintentar</button><button type="button" onClick={() => { setLoaded(false); setMirror(value => !value); }}>Servidor alternativo</button><a href={casinoLaunchUrl(game, mirror)} target="_blank" rel="noopener noreferrer">Abrir en otra pestaña ↗</a></div></div>
      <div className="casino-player-info"><div><span className="casino-eyebrow">CÓMO JUGAR</span><h2>{game.description}</h2><p>Los controles y las reglas están dentro del juego. Sus fichas no se transfieren a la billetera de Fortuna.Bet. El idioma, los anuncios y el guardado de partidas los gestiona el proveedor.</p></div><a href={game.source} target="_blank" rel="noopener noreferrer">Ficha oficial del juego ↗</a></div>
      <section className="casino-more" aria-labelledby="casino-more-title"><h2 id="casino-more-title">Otra mesa, otra partida</h2><div className="casino-grid">{CASINO_GAMES.filter(item => item.slug !== game.slug).slice(0, 3).map(item => <GameCard key={item.slug} game={item} />)}</div></section>
    </div>
  );
}

export function CasinoPage() {
  const { gameId } = useParams();
  const game = findCasinoGame(gameId);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [gameId]);
  if (!gameId) return <CasinoLobby />;
  if (!game) return <div className="casino-page casino-empty"><h1>Este juego no está en el catálogo</h1><p>Elige uno de los juegos disponibles para comenzar.</p><Link to="/casino" className="casino-primary">Volver al casino</Link></div>;
  return <CasinoPlayer key={game.slug} game={game} />;
}
