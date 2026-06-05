"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  value: string;
  min?: string;
  max?: string;
  onChange: (iso: string) => void;
  className?: string;
  ariaLabel?: string;
};

function isoToBr(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function brToIso(br: string): string | null {
  const m = br.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const day = Number(d);
  const month = Number(mo);
  const year = Number(y);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(year, month - 1, day);
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day
  ) {
    return null;
  }
  return `${y}-${mo}-${d}`;
}

function maskDigits(input: string): string {
  const digits = input.replace(/\D/g, "").slice(0, 8);
  if (digits.length > 4) {
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  }
  if (digits.length > 2) {
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  }
  return digits;
}

export default function BRDateInput({
  value,
  min,
  max,
  onChange,
  className,
  ariaLabel,
}: Props) {
  const [text, setText] = useState<string>(() => isoToBr(value));
  const pickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(isoToBr(value));
  }, [value]);

  function tryCommit(next: string) {
    const iso = brToIso(next);
    if (!iso) return false;
    if (min && iso < min) return false;
    if (max && iso > max) return false;
    if (iso !== value) onChange(iso);
    return true;
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const masked = maskDigits(e.target.value);
    setText(masked);
    if (masked.length === 10) tryCommit(masked);
  }

  function handleBlur() {
    if (!tryCommit(text)) setText(isoToBr(value));
  }

  function openPicker() {
    const el = pickerRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
        return;
      } catch {
        /* fall through */
      }
    }
    el.focus();
    el.click();
  }

  return (
    <span className="brDateInput">
      <input
        type="text"
        className={className}
        value={text}
        placeholder="dd/mm/aaaa"
        inputMode="numeric"
        maxLength={10}
        aria-label={ariaLabel}
        onChange={handleChange}
        onBlur={handleBlur}
      />
      <button
        type="button"
        className="brDateInputButton"
        onClick={openPicker}
        aria-label="Abrir calendário"
        tabIndex={-1}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
          <path d="M2.5 6.5h11" />
          <path d="M5.5 2v3M10.5 2v3" />
        </svg>
      </button>
      <input
        ref={pickerRef}
        type="date"
        className="brDateInputPicker"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
        tabIndex={-1}
        aria-hidden="true"
      />
    </span>
  );
}
