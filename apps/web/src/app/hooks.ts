import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import {
  loadFilters,
  makeFilterState,
  saveFilters,
  type FilterState,
} from "../filters";
import { useCatalog } from "./store";

export function useMedia(query: string) {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
export function useQuery() {
  const [params, setParams] = useSearchParams();
  function update(values: Record<string, string | null>, replace = false) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(values)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace },
    );
  }
  return { params, update };
}
export function useFilters(key: string) {
  const { cat } = useCatalog();
  const read = () => {
    const value = makeFilterState();
    loadFilters(value, new Set(cat.venues.map((v) => v.id)), key);
    return value;
  };
  const [filters, setFilters] = useState(read);
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key === key || e.key === null) setFilters(read());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
    // 目录与存储键在筛选器的整个生命周期里都是同一个读取器（两者一变就得换实例）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, key]);
  const update = (patch: Partial<FilterState>) => {
    const next = { ...filters, ...patch };
    saveFilters(next, key);
    setFilters(next);
  };
  return { filters, update };
}
