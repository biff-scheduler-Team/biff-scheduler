import type {Catalog, Screening} from '../types';

export function screeningMembers(cat: Catalog, screening: Screening) {
  return (screening.midnight_members ?? []).map(name => ({
    name,
    film: cat.filmByEn.get(name) ?? cat.filmByOrig.get(name)?.[0],
  }));
}
