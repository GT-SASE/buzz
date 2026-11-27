/**
 * Answers for /faq, and the three the join page repeats. Every answer restates
 * copy that already ships on the site: `meeting` and the programs in
 * `~/data/content`, the join and contact pages, the portal's point tiers and
 * the chapter inbox. Nothing here is a new claim. Where the site has no answer
 * (the weekly meeting day, time and room) the question points at the feeds
 * instead of guessing.
 *
 * Answers are plain strings because they are also the FAQPage JSON-LD text.
 */

import { meeting } from "~/data/content";
import { mentorshipTiers, tiers } from "~/data/portal";
import { site } from "~/data/site";

type Faq = { id: string; q: string; a: string };

const ranks = tiers.map((tier) => `${tier.name} (${tier.min})`).join(", ");
const kinLevels = mentorshipTiers
  .map((tier) => `${tier.name} (${tier.min})`)
  .join(", ");

export const faqs = [
  {
    id: "join",
    q: "How do I join?",
    a: "Come to a general body meeting, check in with the member portal, and follow the chapter feeds on Instagram, Discord, and Engage. There is no application. Membership is a member portal account, so the Join SASE button, which signs you in, is how you become a member.",
  },
  {
    id: "cost",
    q: "Are there dues?",
    a: "No. Membership is free: no application, no dues, and no major requirement. Chapter points come from showing up, not from paying in.",
  },
  {
    id: "heritage",
    q: "Do I have to be Asian to join?",
    a: "No. SASE is open to every Georgia Tech student regardless of heritage, major, or year.",
  },
  {
    id: "major",
    q: "Do I need a technical major?",
    a: "No. Our members study everything from computer science to business to public policy.",
  },
  {
    id: "mid-semester",
    q: "What if I join mid-semester?",
    a: "Come anyway. You can join a SASE KIN group any time during the school year, and project teams have rolling spots most semesters.",
  },
  {
    id: "meetings",
    q: "When and where are the meetings?",
    a: `${meeting.summary} The events calendar lists what is coming up. Nothing is required to attend.`,
  },
  {
    id: "bring",
    q: "What should I bring?",
    a: "Nothing is required to attend a general body meeting, and you do not need to be a member to show up. To check in and earn the event's points, scan the QR code on the presentation screen with the member portal. For the resume workshop, bring a draft of your resume. A draft of anything is fine.",
  },
  {
    id: "points",
    q: "How do points work?",
    a: `Each event is worth a set number of points, and checking in at the door earns them. Your total sets your rank. The number in brackets is the total where each rank starts: ${ranks}. SASE KIN points are counted on their own, with their own levels: ${kinLevels}.`,
  },
  {
    id: "digest",
    q: "How do I get the weekly digest?",
    a: `It is a weekly email of events, corporate info sessions, and internship postings. Email ${site.email} to be added, or sign up at any general body meeting.`,
  },
  {
    id: "sponsor",
    q: "How can my company sponsor the chapter?",
    a: `Sponsorship runs from a single info session to a named signature event. The Sponsors page lists the tiers. Write to ${site.email} and the officer who handles corporate relations will pick it up.`,
  },
] as const satisfies readonly Faq[];

type FaqId = (typeof faqs)[number]["id"];

/** The answers for these ids, in the order given. */
export function faqsById(...ids: FaqId[]) {
  return ids.map((id) => faqs.find((faq) => faq.id === id)!);
}
