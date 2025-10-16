import React, { type JSX } from "react";

export type SortKey = "latest" | "popular";

export interface SortButtonsProps {
  value: SortKey;
  onChange: (next: SortKey) => void;
}

export default function SortButtons(props: SortButtonsProps): JSX.Element {
  const { value, onChange } = props;

  return (
    <div className="flex gap-2">
      <SortButton
        active={value === "latest"}
        onClick={() => onChange("latest")}
      >
        新着順
      </SortButton>
      <SortButton
        active={value === "popular"}
        onClick={() => onChange("popular")}
      >
        人気順
      </SortButton>
    </div>
  );
}

function SortButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  const { active, onClick, children } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-3 py-2 rounded-md text-sm border " +
        (active
          ? "bg-emerald-600 text-white border-emerald-600"
          : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")
      }
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
