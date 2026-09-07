import { describe, expect, it } from "vitest";

import {
  parseResumeUpload,
  RESUME_MAX_BYTES,
  sanitizeResumeFileName,
} from "../packages/api/src/resume";

function pdfBytes(extra = 0) {
  const bytes = new Uint8Array(5 + extra);
  bytes.set(Buffer.from("%PDF-", "ascii"));
  return bytes;
}

describe("sanitizeResumeFileName", () => {
  it("keeps a normal pdf name", () => {
    expect(sanitizeResumeFileName("Ada Lovelace.pdf")).toBe("Ada Lovelace.pdf");
  });

  it("strips a windows path and forces .pdf", () => {
    expect(sanitizeResumeFileName("C:\\\\Users\\\\ada\\\\resume.PDF")).toBe(
      "resume.pdf",
    );
  });

  it("drops characters that break Content-Disposition", () => {
    expect(sanitizeResumeFileName('bad"name?.docx')).toBe("badname.docx.pdf");
  });
});

describe("parseResumeUpload", () => {
  it("accepts a small pdf", () => {
    const parsed = parseResumeUpload({
      name: "resume.pdf",
      type: "application/pdf",
      bytes: pdfBytes(20),
    });
    expect(parsed).toMatchObject({
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      byteSize: 25,
    });
    if ("fileBytes" in parsed) {
      expect(
        Buffer.from(parsed.fileBytes, "base64").equals(
          Buffer.from(pdfBytes(20)),
        ),
      ).toBe(true);
    }
  });

  it("accepts a pdf with an empty browser mime type", () => {
    const parsed = parseResumeUpload({
      name: "resume.pdf",
      type: "",
      bytes: pdfBytes(),
    });
    expect(parsed).toMatchObject({ fileName: "resume.pdf" });
  });

  it("rejects a non-pdf", () => {
    expect(
      parseResumeUpload({
        name: "photo.png",
        type: "image/png",
        bytes: new Uint8Array([137, 80, 78, 71]),
      }),
    ).toEqual({ error: "Upload a PDF." });
  });

  it("rejects a pdf that is too large", () => {
    expect(
      parseResumeUpload({
        name: "resume.pdf",
        type: "application/pdf",
        bytes: pdfBytes(RESUME_MAX_BYTES),
      }),
    ).toEqual({ error: "Resumes must be a PDF of 2 MB or less." });
  });

  it("rejects an empty file", () => {
    expect(
      parseResumeUpload({
        name: "resume.pdf",
        type: "application/pdf",
        bytes: new Uint8Array(),
      }),
    ).toEqual({ error: "The file is empty." });
  });
});
