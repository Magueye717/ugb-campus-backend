import type { Campus } from '../accounts/index.js';

export type CatalogResto = { slug: string; name: string; location: string; campus: Campus; coords: { lat: number; lng: number } };

/** The university restaurants every database starts with (public-restos migration); the team adds others in the app. */
export const CAMPUS_RESTOS: CatalogResto[] = [
  { slug: 'resto-1', name: 'Resto 1', location: 'Campus 1, près de la direction du CROUS', campus: 'campus1', coords: { lat: 16.0657, lng: -16.42605 } },
  { slug: 'resto-2', name: 'Resto 2', location: 'Campus 1, près de l’arrêt de bus', campus: 'campus1', coords: { lat: 16.06777, lng: -16.42155 } },
];
