export const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2,
});

export const USD = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

export const INT = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });

const DAY_LABEL_FMT = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function todayKey(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function daysAgoKey(days: number): string {
  const now = new Date();
  const dt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days),
  );
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return DAY_LABEL_FMT.format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toLocaleString("pt-BR", { maximumFractionDigits: v >= 100 ? 0 : 2 })} ${units[i]}`;
}

export function formatSlotHours(slotMs: number): string {
  if (!Number.isFinite(slotMs) || slotMs <= 0) return "0 h";
  const hours = slotMs / 1000 / 3600;
  return `${hours.toLocaleString("pt-BR", { maximumFractionDigits: hours >= 100 ? 0 : 2 })} slot·h`;
}

export function emailLabel(email: string): string {
  if (email === "(sem usuário)") return email;
  return email.split("@")[0] || email;
}

export function formatUsd(value: number | string): string {
  const n = typeof value === "number" ? value : Number(value);
  return `US$ ${USD.format(Number.isFinite(n) ? n : 0)}`;
}

export function formatBrl(value: number | string): string {
  const n = typeof value === "number" ? value : Number(value);
  return BRL.format(Number.isFinite(n) ? n : 0);
}
