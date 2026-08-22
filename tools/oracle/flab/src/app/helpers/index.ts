// VENDOR PATCH: upstream helpers/index.ts pulls in primeng/api and rxjs (for
// UI/Observable helpers the solver never calls). Trimmed to the helpers the
// simplex/rate/recipe closure actually uses.
import { Rational, rational } from '~/models/rational';
import { Entities, Optional } from '~/models/utils';

/**
 * Function equivalent to `value ?? fallback`. Primarily intended to reduce test
 * branch surface area where nullable values are present.
 */
export function coalesce<T>(value: Optional<T>, fallback: T): T {
  return value ?? fallback;
}

export function cloneEntities<T>(value: Entities<T>): Entities<T>;
export function cloneEntities<T>(
  value: Optional<Entities<T>>,
): Optional<Entities<T>>;
export function cloneEntities<T>(
  value: Optional<Entities<T>>,
): Optional<Entities<T>> {
  if (value == null) return;
  return spread(value);
}

export function contains<T>(entities: Entities<T>, value: T): boolean {
  return Object.keys(entities).some((k) => entities[k] === value);
}

/** Spread, but ensures type safety of the object to be applied */
export function spread<T>(obj: T, ...apply: Partial<T>[]): T {
  if (apply.length === 0) return { ...obj };
  for (const a of apply) obj = { ...obj, ...a };
  return obj;
}

export function toEntities<T extends { id: string }>(
  value: T[],
  warn = false,
): Entities<T> {
  if (warn) {
    return value.reduce((e: Entities<T>, v) => {
      if (e[v.id]) console.warn(`Duplicate id: ${v.id}`);
      e[v.id] = v;
      return e;
    }, {});
  }

  return value.reduce((e: Entities<T>, v) => {
    e[v.id] = v;
    return e;
  }, {});
}

export function toRationalEntities(
  value: Entities<string | number>,
): Entities<Rational>;
export function toRationalEntities(
  value: Optional<Entities<string | number>>,
): Optional<Entities<Rational>>;
export function toRationalEntities(
  value: Optional<Entities<string | number>>,
): Optional<Entities<Rational>> {
  if (value == null) return;
  return Object.keys(value).reduce((e: Entities<Rational>, v) => {
    e[v] = rational(value[v]);
    return e;
  }, {});
}
