import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router";
import { useCatalog } from "./store";
import { pickDefaultDate, todayIsoLocal } from "../util";

export interface ScheduleSelection {
  date: string;
  hour: number | null;
}
const ScheduleSelectionContext = createContext<ScheduleSelection | null>(null);

/** Date is chosen once per app session; explicit route dates become the current date. */
export function ScheduleSelectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { cat } = useCatalog();
  const [params] = useSearchParams();
  const requested = params.get("date");
  const explicit =
    requested && cat.dates.includes(requested) ? requested : null;
  const [currentDate, setCurrentDate] = useState(
    () =>
      explicit ??
      pickDefaultDate(
        cat.dates,
        todayIsoLocal(),
        window.matchMedia("(max-width: 768px)").matches,
      ),
  );
  const date = explicit ?? currentDate;
  useEffect(() => {
    if (explicit) setCurrentDate(explicit);
  }, [explicit]);
  const rawHour = params.get("hour");
  const hour =
    rawHour !== null && Number.isFinite(Number(rawHour))
      ? Number(rawHour)
      : null;
  return (
    <ScheduleSelectionContext.Provider value={{ date, hour }}>
      {children}
    </ScheduleSelectionContext.Provider>
  );
}

export function useScheduleSelection() {
  const value = useContext(ScheduleSelectionContext);
  if (!value) throw new Error("ScheduleSelectionProvider is missing");
  return value;
}
