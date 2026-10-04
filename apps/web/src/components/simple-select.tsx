import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface Option {
  value: string;
  label: string;
}

const NONE = "__none__";

/** A value/label select. `allowEmpty` adds a "None" choice that maps to "". */
export function SimpleSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  allowEmpty,
  emptyLabel = "None",
  size,
  className,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  allowEmpty?: boolean;
  emptyLabel?: string;
  size?: "sm" | "default" | "lg";
  className?: string;
  id?: string;
}) {
  const items = allowEmpty ? [{ value: NONE, label: emptyLabel }, ...options] : options;
  return (
    <Select
      items={items}
      value={value || (allowEmpty ? NONE : null)}
      onValueChange={(v) => onChange(v === NONE || v == null ? "" : String(v))}
    >
      <SelectTrigger size={size} className={className} id={id}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup>
        {items.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
