/**
 * Arte y lema de cada juego para las tarjetas de «Nuestros juegos».
 * Los juegos sin ilustración usan un fondo de color con su ícono (GameCard).
 */
import mer01 from '../assets/games/MER-01.png';
import mer02 from '../assets/games/MER-02.png';
import mer05 from '../assets/games/MER-05.png';
import mer06 from '../assets/games/MER-06.png';
import mer07 from '../assets/games/MER-07.png';
import mer10 from '../assets/games/MER-10.png';

export interface GameArt {
  image?: string;
  tagline: string;
  /** Respaldo sin ilustración: ícono grande y colores del degradado. */
  icon: string;
  from: string;
  to: string;
}

const ART: Record<string, GameArt> = {
  'MER-05': { image: mer05, tagline: 'La suerte del pueblo merideño', icon: '🐆', from: '#1b7a58', to: '#0a2a1c' },
  'MER-03': { tagline: 'Los sabores de nuestra tierra', icon: '🍓', from: '#b91c1c', to: '#3f0d0d' },
  'MER-01': { image: mer01, tagline: 'Más oportunidades para nuestra gente', icon: '🎯', from: '#b91c1c', to: '#450a0a' },
  'MER-02': { image: mer02, tagline: 'La emoción llega más alto', icon: '🚡', from: '#0369a1', to: '#082f49' },
  'MER-04': { tagline: 'Dos cifras, cumbre de premios', icon: '🏔️', from: '#0e7490', to: '#083344' },
  'MER-09': { tagline: 'Tu número y tu color', icon: '🦅', from: '#ca8a04', to: '#422006' },
  'MER-06': { image: mer06, tagline: 'Tradición que une', icon: '⛰️', from: '#15803d', to: '#052e16' },
  'MER-10': { image: mer10, tagline: 'Cinco números, un mismo destino', icon: '⭐', from: '#1d4ed8', to: '#0b1a45' },
  'MER-08': { tagline: 'Cuatro cifras, grandes emociones', icon: '🗻', from: '#7c3aed', to: '#2e1065' },
  'MER-07': { image: mer07, tagline: 'Dos números, más oportunidades', icon: '🎲', from: '#be123c', to: '#4c0519' },
};

export function gameArt(code: string): GameArt {
  return ART[code] ?? { tagline: 'Juega con responsabilidad', icon: '🍀', from: '#1b7a58', to: '#0a2a1c' };
}
