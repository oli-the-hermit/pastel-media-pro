import { IconChevronDown, Menu } from '@pastel-studio/react';
import { strings } from '../strings';

/**
 * A list's sort: the order in use as plain text with a chevron, which opens a quiet menu of the orders. Not a
 * field: among a page's controls only the search is one (ux.md §6, one shape per kind of control).
 */
export function SortMenu<T extends string>({ orders, labels, value, onChange }: {
  orders: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (order: T) => void;
}) {
  return (
    <Menu
      align="end"
      ariaLabel={strings.lists.sortedBy(labels[value])}
      triggerClassName="mp-sort"
      trigger={
        <>
          {labels[value]}
          <IconChevronDown size={16} />
        </>
      }
      items={orders.map((order) => ({ key: order, label: labels[order], checked: order === value, radio: true, onSelect: () => onChange(order) }))}
    />
  );
}
