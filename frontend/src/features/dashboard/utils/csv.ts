/** Exporta linhas como arquivo CSV (com BOM p/ Excel abrir UTF-8 correto). */

export function csvEscape(value: string | number | null | undefined): string {
  const normalized = String(value ?? "");
  if (
    !normalized.includes('"') &&
    !normalized.includes(",") &&
    !normalized.includes("\n")
  ) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '""')}"`;
}

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
) {
  const lines = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => row.map(csvEscape).join(",")),
  ];
  const csvContent = `\uFEFF${lines.join("\n")}`;
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
