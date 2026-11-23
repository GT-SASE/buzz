import { describe, expect, it } from "bun:test";

import { faqs, faqsById } from "../sites/web/src/data/faq";
import { meeting } from "../sites/web/src/data/content";
import { mentorshipTiers, tiers } from "../sites/web/src/data/portal";
import { site } from "../sites/web/src/data/site";
import { faqSchema } from "../sites/web/src/lib/seo";
import { buildSitemap } from "../sites/web/src/lib/sitemap";

describe("faqs", () => {
  it("has unique ids and no blank question or answer", () => {
    expect(new Set(faqs.map((faq) => faq.id)).size).toBe(faqs.length);
    for (const faq of faqs) {
      expect(faq.q.trim().endsWith("?")).toBe(true);
      expect(faq.a.trim().length).toBeGreaterThan(20);
    }
  });

  it("answers dues, meeting time and place, what to bring, joining and points", () => {
    const answer = (id: string) => faqs.find((faq) => faq.id === id)?.a ?? "";

    expect(answer("cost")).toMatch(/no dues/i);
    expect(answer("meetings")).toContain(meeting.summary);
    expect(answer("bring")).toMatch(/QR code/);
    expect(answer("bring")).toMatch(/resume/);
    expect(answer("join")).toMatch(/general body meeting/);
    expect(answer("points")).toMatch(/rank/);
  });

  it("states the point thresholds the portal ranks use, not a copy of them", () => {
    const points = faqs.find((faq) => faq.id === "points")?.a ?? "";
    for (const tier of tiers)
      expect(points).toContain(`${tier.name} (${tier.min})`);
    for (const tier of mentorshipTiers) {
      expect(points).toContain(`${tier.name} (${tier.min})`);
    }
  });

  it("does not invent a meeting day, time or room", () => {
    const meetings = faqs.find((faq) => faq.id === "meetings")?.a ?? "";
    expect(meetings).not.toMatch(
      /\b(mon|tues|wednes|thurs|fri)day\b|\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i,
    );
  });

  it("keeps answers as plain text for the JSON-LD", () => {
    for (const faq of faqs) expect(faq.a).not.toMatch(/[<>]/);
  });

  it("picks answers by id, in the order asked", () => {
    expect(faqsById("major", "heritage").map((faq) => faq.id)).toEqual([
      "major",
      "heritage",
    ]);
  });
});

describe("faqSchema", () => {
  it("is a FAQPage with one Question per entry", () => {
    const schema = faqSchema(faqs);

    expect(schema["@context"]).toBe("https://schema.org");
    expect(schema["@type"]).toBe("FAQPage");
    expect(schema.mainEntity).toHaveLength(faqs.length);
    expect(schema.mainEntity[0]).toEqual({
      "@type": "Question",
      name: faqs[0].q,
      acceptedAnswer: { "@type": "Answer", text: faqs[0].a },
    });
  });
});

describe("sitemap", () => {
  it("lists /faq with the other public pages", () => {
    const urls = buildSitemap([]).map((entry) => entry.url);
    expect(urls).toContain(`${site.url}/faq`);
  });

  it("lists /faq once", () => {
    const urls = buildSitemap([]).map((entry) => entry.url);
    expect(urls.filter((url) => url.endsWith("/faq"))).toHaveLength(1);
  });
});
