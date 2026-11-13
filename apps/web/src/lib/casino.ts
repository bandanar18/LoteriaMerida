import fruitArt from '../assets/casino/fruit-slot-machine.jpg';
import rouletteArt from '../assets/casino/las-vegas-roulette.jpg';
import pokerArt from '../assets/casino/las-vegas-poker.jpg';
import blackjackArt from '../assets/casino/las-vegas-blackjack.jpg';
import vegasArt from '../assets/casino/lucky-vegas-slots.jpg';
import westArt from '../assets/casino/wild-west-slot-machine.jpg';

/** Curated games using the provider's published embed URLs. No wallet or authentication data is sent. */
export type CasinoCategory = 'slots' | 'ruleta' | 'cartas';

export interface CasinoGame {
  slug: string;
  name: string;
  category: CasinoCategory;
  providerId: string;
  source: string;
  description: string;
  badge: string;
  accent: string;
  artwork: string;
}

export const CASINO_CATEGORIES: { id: 'todos' | CasinoCategory; label: string; symbol: string }[] = [
  { id: 'todos', label: 'Todos los juegos', symbol: '✦' },
  { id: 'slots', label: 'Slots', symbol: '777' },
  { id: 'ruleta', label: 'Ruleta', symbol: '◉' },
  { id: 'cartas', label: 'Póker y cartas', symbol: '♠' },
];

export const CASINO_GAMES: readonly CasinoGame[] = [
  {
    slug: 'fruit-slot-machine', name: 'Fruit Slot Machine', category: 'slots',
    providerId: 'tngy38wzt2o6pv2a3lu89itkh8xjecj7',
    source: 'https://gamemonetize.com/fruit-slot-machine-game',
    description: 'El clásico de frutas: elige tus líneas y haz girar los rodillos.',
    badge: 'FRUTAS', accent: '#ecad36', artwork: fruitArt,
  },
  {
    slug: 'las-vegas-roulette', name: 'Las Vegas Roulette', category: 'ruleta',
    providerId: 'goi9fthuhue9ozrkysiqglk0gx6rcedt',
    source: 'https://gamemonetize.com/las-vegas-roulette-game',
    description: 'La mesa está lista. Coloca tus fichas y sigue el giro de la ruleta.',
    badge: 'RULETA', accent: '#c83149', artwork: rouletteArt,
  },
  {
    slug: 'las-vegas-poker', name: 'Las Vegas Poker', category: 'cartas',
    providerId: '9tipe1jv9rmgplp51gs8lw7nalqqb59k',
    source: 'https://gamemonetize.com/las-vegas-poker-game',
    description: 'Lee la mesa, combina tus cartas y pon a prueba tu estrategia.',
    badge: 'PÓKER', accent: '#8558c7', artwork: pokerArt,
  },
  {
    slug: 'las-vegas-blackjack', name: 'Las Vegas Blackjack', category: 'cartas',
    providerId: 'dd3qdr8ueb2xnxik6k9u2gcg87f5bm9o',
    source: 'https://gamemonetize.com/las-vegas-blackjack-game',
    description: 'Pide carta o plántate: acércate a 21 sin pasarte.',
    badge: 'BLACKJACK', accent: '#1c9e83', artwork: blackjackArt,
  },
  {
    slug: 'lucky-vegas-slots', name: 'Lucky Vegas Slots', category: 'slots',
    providerId: 'bnmf23gsgsr8mmo0wrih2ywhrgieimho',
    source: 'https://gamemonetize.com/lucky-vegas-slots-game',
    description: 'Luces de Las Vegas y distintas máquinas para descubrir.',
    badge: 'VEGAS', accent: '#a25dc1', artwork: vegasArt,
  },
  {
    slug: 'wild-west-slot-machine', name: 'Wild West Slot Machine', category: 'slots',
    providerId: 'qucrlvd8regh2mamyobn6xbcbws7fp25',
    source: 'https://gamemonetize.com/wild-west-slot-machine-game',
    description: 'Rodillos, líneas y ambiente del Oeste en una máquina clásica.',
    badge: 'SLOTS DEL OESTE', accent: '#be7430', artwork: westArt,
  },
];

export const casinoThumbnail = (game: CasinoGame) => game.artwork;
export const casinoLaunchUrl = (game: CasinoGame, mirror = false) =>
  `https://html5.gamemonetize.${mirror ? 'co' : 'games'}/${game.providerId}/`;

export function findCasinoGame(slug: string | undefined) {
  return CASINO_GAMES.find(game => game.slug === slug);
}

export const normalizeCasinoSearch = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
