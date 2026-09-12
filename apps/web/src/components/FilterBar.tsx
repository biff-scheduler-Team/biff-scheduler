import {
  ActionButton,
  Checkbox,
  CheckboxGroup,
  Disclosure,
  DisclosurePanel,
  DisclosureTitle,
  Picker,
  PickerItem,
  ToggleButton,
} from "./spectrum";
import {
  filterSummary,
  hasActiveFilter,
  makeFilterState,
  type FilterState,
} from "../filters";
import { SUBS_DEFS, venueShort } from "../legend";
import { useCatalog } from "../app/store";

export function FilterBar({
  filters,
  onChange,
  label,
  fieldsOnly = false,
}: {
  filters: FilterState;
  onChange: (patch: Partial<FilterState>) => void;
  label: string;
  fieldsOnly?: boolean;
}) {
  const { cat } = useCatalog();
  const groups = [...new Set(cat.venues.map((v) => v.group))];
  const toggleVenues = (ids: string[]) => {
    const next = new Set(filters.venues);
    if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    onChange({ venues: next });
  };
  const fields = (
        <div className="filter-fields">
          <CheckboxGroup
            label="字幕与对白"
            orientation="horizontal"
            value={[...filters.subs]}
            onChange={(subs) => onChange({ subs: new Set(subs) })}
          >
            {Object.values(SUBS_DEFS).map((d) => (
              <Checkbox key={d.label} value={d.label}>
                {d.label}
              </Checkbox>
            ))}
            <Checkbox value="none">未标注</Checkbox>
          </CheckboxGroup>
          <div className="inline-fields">
            <Picker
              label="场次类型"
              value={filters.gv ?? "all"}
              onChange={(v) =>
                onChange({ gv: v === "gv" || v === "plain" ? v : null })
              }
            >
              <PickerItem id="all">全部场次</PickerItem>
              <PickerItem id="gv">仅 GV</PickerItem>
              <PickerItem id="plain">非 GV</PickerItem>
            </Picker>
            <Picker
              label="影厅筛选方式"
              value={filters.venueMode}
              onChange={(v) =>
                onChange({ venueMode: v === "exclude" ? "exclude" : "include" })
              }
            >
              <PickerItem id="include">只看选中影厅</PickerItem>
              <PickerItem id="exclude">排除选中影厅</PickerItem>
            </Picker>
          </div>
          <div className="inline-actions" aria-label="影院快捷选择">
            {groups.map((group) => {
              const ids = cat.venues
                .filter((v) => v.group === group)
                .map((v) => v.id);
              return (
                <ToggleButton
                  key={group}
                  isSelected={ids.every((id) => filters.venues.has(id))}
                  onChange={() => toggleVenues(ids)}
                >
                  {group.toUpperCase()}
                </ToggleButton>
              );
            })}
            <ActionButton
              onPress={() =>
                toggleVenues(
                  cat.venues
                    .filter((v) => v.region === "centum")
                    .map((v) => v.id),
                )
              }
            >
              主场区
            </ActionButton>
            <ActionButton
              onPress={() =>
                toggleVenues(
                  cat.venues
                    .filter((v) => v.region === "nampo")
                    .map((v) => v.id),
                )
              }
            >
              南浦洞
            </ActionButton>
            <ActionButton
              onPress={() =>
                onChange({
                  venues: new Set(
                    cat.venues
                      .filter((v) => !filters.venues.has(v.id))
                      .map((v) => v.id),
                  ),
                })
              }
            >
              反选影厅
            </ActionButton>
          </div>
          <Picker
            label="逐厅选择"
            selectionMode="multiple"
            value={[...filters.venues]}
            onChange={(ids) => onChange({ venues: new Set(ids.map(String)) })}
          >
            {cat.venues.map((v) => (
              <PickerItem id={v.id} key={v.id}>
                {v.code} {venueShort(v)}
              </PickerItem>
            ))}
          </Picker>
          {hasActiveFilter(filters) && (
            <ActionButton onPress={() => onChange(makeFilterState())}>
              清除筛选
            </ActionButton>
          )}
        </div>
  );
  if (fieldsOnly) return fields;
  return (
    <Disclosure>
      <DisclosureTitle>
        {label}
        {hasActiveFilter(filters) ? `：${filterSummary(filters).replaceAll(" · ", "，")}` : ""}
      </DisclosureTitle>
      <DisclosurePanel>{fields}</DisclosurePanel>
    </Disclosure>
  );
}
