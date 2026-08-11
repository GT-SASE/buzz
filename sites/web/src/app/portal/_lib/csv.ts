/**
 * RFC 4180 quoting, plus formula neutralisation.
 *
 * Member names come from Google profiles, so a member controls this string. A
 * name beginning `=`, `+`, `-`, `@`, tab or CR is executed as a formula by
 * Excel and Sheets when the officer opens the export — `=HYPERLINK(...)` and
 * friends. Quoting alone does not stop it; the leading apostrophe does, and
 * spreadsheets strip it from the displayed value.
 */
export function csvCell(value: string | number | null | undefined) {
  const text = String(value ?? "");
  const neutralised = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${neutralised.replace(/"/g, '""')}"`;
}

/** CRLF between rows, because that is what RFC 4180 and Excel expect. */
export function toCsv(rows: (string | number | null | undefined)[][]) {
  return rows
    .map((row) => row.map((cell) => csvCell(cell)).join(","))
    .join("\r\n");
}

export function downloadCsv(filename: string, csv: string) {
  // UTF-8 BOM so Excel on Windows does not mangle non-ASCII names on open.
  const url = URL.createObjectURL(
    new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;

  // Connected before the click and revoked on a later task: Chromium tolerates
  // a detached anchor and a same-task revoke, Firefox cancels the download.
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
