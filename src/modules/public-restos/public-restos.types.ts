import type { ObjectId } from 'mongodb';

import type { Campus } from '../accounts/index.js';

export const MEALS = ['lunch', 'dinner'] as const;
export type Meal = (typeof MEALS)[number];
export const MEAL_LABELS: Record<Meal, string> = { lunch: 'déjeuner', dinner: 'dîner' };

/** Stock level shown to students. `out` ("rupture"): nothing left, an alert goes on the home screen. */
export const DISH_STATUSES = ['available', 'low', 'out'] as const;
export type DishStatus = (typeof DISH_STATUSES)[number];

/** Local time "HH:MM" (Africa/Dakar). */
export type Service = { start: string; end: string };

/** A university restaurant ("Resto 1"), run by the university's catering staff. */
export type PublicRestoDoc = {
  _id: ObjectId;
  /** "resto-1", unique. */
  slug: string;
  name: string;
  /** "Campus 1, près du Village A". */
  location: string;
  /** Where it is: its "ruptures" go to that campus's students only. Null: for everyone. */
  campus: Campus | null;
  /** Its GPS point, for directions; missing on older ones. */
  point?: { lat: number; lng: number } | null;
  /** Display order. */
  sortOrder: number;
  /** Service hours per meal. */
  services: Record<Meal, Service>;
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
};

export type Dish = {
  /** Stable within the menu: stock updates and alerts point to it. */
  dishId: string;
  name: string;
  /** "Riz au poisson". */
  detail: string;
  status: DishStatus;
  statusAt: Date;
};

/** What a restaurant serves at one meal of one day. One per restaurant, date and meal. */
export type PublicMenuDoc = {
  _id: ObjectId;
  restoId: ObjectId;
  /** Local date (Africa/Dakar) "YYYY-MM-DD". */
  date: string;
  meal: Meal;
  dishes: Dish[];
  createdBy: ObjectId | null;
  updatedBy: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DishInput = { id?: string; name: string; detail?: string; status?: DishStatus };

/**
 * The dishes the catering staff pick from when composing a menu: predefined ones (seeded) and every dish a publisher
 * typed once. One per name (`key`: lowercased, spaces collapsed).
 */
export type PublicDishDoc = {
  _id: ObjectId;
  key: string;
  name: string;
  /** The latest detail used: "Riz au poisson". */
  detail: string;
  /** The meals it has been served at (suggested first there). */
  meals: Meal[];
  /** How many menus have included it: the most served come first. */
  uses: number;
  createdAt: Date;
  updatedAt: Date;
};
