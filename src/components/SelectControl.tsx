import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

export function SelectControl({
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-control">
      <select {...props}>{children}</select>
      <ChevronDown size={15} aria-hidden="true" />
    </span>
  );
}
