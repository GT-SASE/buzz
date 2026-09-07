import { RESUME_MAX_BYTES } from "@buzz/db";

export { RESUME_MAX_BYTES };

export const RESUME_MIME = "application/pdf";

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

export type ParsedResume = {
  fileName: string;
  mimeType: typeof RESUME_MIME;
  byteSize: number;
  fileBytes: string;
};

export type ResumeParseError = { error: string };

function basename(name: string) {
  return name.replace(/^.*[/\\]/, "").trim();
}

export function sanitizeResumeFileName(name: string) {
  const base = basename(name)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["<>|:*?]/g, "")
    .slice(0, 170);
  const withoutExt = base.replace(/\.pdf$/i, "").trim() || "resume";
  return `${withoutExt}.pdf`;
}

export function parseResumeUpload(input: {
  name: string;
  type: string;
  bytes: Uint8Array;
}): ParsedResume | ResumeParseError {
  if (input.bytes.byteLength === 0) {
    return { error: "The file is empty." };
  }
  if (input.bytes.byteLength > RESUME_MAX_BYTES) {
    return { error: "Resumes must be a PDF of 2 MB or less." };
  }

  const mime = input.type.trim().toLowerCase();
  if (mime && mime !== RESUME_MIME) {
    return { error: "Upload a PDF." };
  }

  const head = input.bytes.subarray(0, PDF_MAGIC.length);
  if (!Buffer.from(head).equals(PDF_MAGIC)) {
    return { error: "Upload a PDF." };
  }

  return {
    fileName: sanitizeResumeFileName(input.name),
    mimeType: RESUME_MIME,
    byteSize: input.bytes.byteLength,
    fileBytes: Buffer.from(input.bytes).toString("base64"),
  };
}

export function resumeDownloadHeaders(fileName: string) {
  const safe = sanitizeResumeFileName(fileName);
  const encoded = encodeURIComponent(safe);
  return {
    "Content-Type": RESUME_MIME,
    "Content-Disposition": `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

export function decodeResumeBytes(fileBytes: string) {
  return Buffer.from(fileBytes, "base64");
}
