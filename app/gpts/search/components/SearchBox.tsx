import React, { type JSX, type ChangeEvent } from "react";

export interface SearchBoxProps {
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
  inputId?: string;
}

export default function SearchBox(props: SearchBoxProps): JSX.Element {
  const { value, placeholder, onChange, inputId = "search-box" } = props;

  function handleChange(e: ChangeEvent<HTMLInputElement>): void {
    onChange(e.target.value);
  }

  return (
    <div className="relative">
      <label htmlFor={inputId} className="sr-only">
        検索キーワード
      </label>
      <input
        id={inputId}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        className="w-full rounded-md border border-gray-300 pl-10 pr-3 py-2 text-[14px] outline-none focus:ring-2 focus:ring-emerald-500"
        inputMode="search"
        aria-label="タイトルで検索"
      />
      <span
        aria-hidden="true"
        className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 select-none"
      >
        🔎
      </span>
    </div>
  );
}
