/**
 * Page content for SASE @ Georgia Tech.
 *
 * Kept apart from `~/data/site` on purpose: this module has module-scope work
 * the bundler cannot prove pure (Intl formatters, `Date.now()`, the event
 * filters below), so anything importing it is pulled into that graph whole.
 * Nothing under "use client" may import this file — the site chrome reads
 * `~/data/site` instead.
 *
 * TODO: every value below is placeholder copy — replace with real chapter data
 * (board roster, event dates, sponsors) before launch.
 */

// TODO: confirm every figure with the board. The corporate-partner count is
// deliberately absent until real partners exist — /sponsors would contradict it.
export const stats = [
  { value: "200+", label: "Active members" },
  { value: "40+", label: "Events per year" },
  { value: "2011", label: "Chapter founded" },
] as const;

// TODO: confirm meeting cadence, day, time, and room with the board.
export const meeting = {
  cadence: "Every other week",
  day: "Thursday",
  time: "6:00 PM",
  location: "Room announced on Instagram each week",
  /** One-sentence version for prose. */
  summary:
    "General body meetings every other Thursday during the semester. Room announced on Instagram each week.",
} as const;

/** Ribbon under the hero — what a member actually gets, in six words or less. */
export const marqueeItems = [
  "Mentor families",
  "Recruiter resume workshops",
  "Technical project teams",
  "Taste of SASE",
  "National convention",
  "Any major, any year",
] as const;

export const missionPillars = [
  {
    icon: "cap",
    title: "Prepare",
    body: "Prepare Asian heritage scientists and engineers for success in the global business world through technical, professional, and leadership development.",
  },
  {
    icon: "globe",
    title: "Celebrate",
    body: "Celebrate diversity on campus and in the workplace, and build a community where students of every background belong.",
  },
  {
    icon: "handshake",
    title: "Contribute",
    body: "Contribute to the Georgia Tech and greater Atlanta communities through outreach, service, and STEM education for the next generation.",
  },
] as const;

// TODO: confirm every program's format and commitment with the committee chairs.
export const programs = [
  {
    slug: "professional-development",
    icon: "briefcase",
    title: "Professional Development",
    body: "Resume reviews, mock interviews, and info sessions with recruiters from our corporate partners.",
    detail:
      "Recruiting season workshops run in the first half of the fall semester: resume line edits with industry mentors, behavioral and technical mock interviews, and closed info sessions hosted by partner companies. Bring a draft of anything — nothing here assumes you already have an internship.",
  },
  {
    slug: "mentorship",
    icon: "compass",
    title: "Mentorship",
    body: "Big/little mentor families pairing first-years with upperclassmen and alumni in industry.",
    detail:
      "Every member who signs up is placed in a mentor family: a small group of first- and second-years matched with upperclassmen, and where possible an alum in industry. Families set their own rhythm — coffee between classes, resume passes before a deadline, someone to text when a semester goes sideways.",
  },
  {
    slug: "technical-projects",
    icon: "terminal",
    title: "Technical Projects",
    body: "Semester-long team projects — software, hardware, and data — built and demoed at the end-of-year showcase.",
    detail:
      "Teams of four to six pick a project in the first weeks of the semester and ship it by the showcase. Past tracks have covered web and mobile software, embedded hardware, and data analysis. Beginners are staffed alongside experienced members on purpose — the point is to leave with something you can talk about in an interview.",
  },
  {
    slug: "community-service",
    icon: "heart",
    title: "Community Service",
    body: "STEM outreach with Atlanta-area K-12 students and volunteering with local nonprofits.",
    detail:
      "Chapter service pairs hands-on STEM outreach for Atlanta-area K-12 students with recurring volunteer days at local nonprofits. Sessions are short and drop-in — a single Saturday morning counts.",
  },
  {
    slug: "socials",
    icon: "cup",
    title: "Socials",
    body: "Boba runs, game nights, Taste of SASE, and intramural sports throughout the semester.",
    detail:
      "The social calendar is the low-stakes way in: boba runs after class, game nights, intramural teams, and Taste of SASE, our cultural food festival. No sign-up sheet and no experience required — just show up.",
  },
  {
    slug: "conferences",
    icon: "trophy",
    title: "Conferences",
    body: "Chapter delegations to the SASE National Convention and the Southeast Regional Conference.",
    detail:
      "The chapter sends delegations to the SASE National Convention and the Southeast Regional Conference, both of which pair a career fair with technical and leadership workshops. The board announces travel details, and any help the chapter can offer with cost, each semester.",
  },
] as const;

export type Program = (typeof programs)[number];

/**
 * Answers the question a hesitant first-year actually has, which is not "what
 * is SASE" but "what happens if I show up". Every step below is drawn from a
 * real program above — nothing here promises anything the chapter does not run.
 */
export const firstMonth = [
  {
    when: "Week one",
    title: "Walk into a general body meeting",
    body: "No application, nothing to pay, no prior involvement assumed. Sit at the back if you want.",
  },
  {
    when: "Week two",
    title: "Get placed in a mentor family",
    body: "A small group of first- and second-years matched with upperclassmen, and where possible an alum in industry.",
  },
  {
    when: "Week three",
    title: "Pick one thing to actually do",
    body: "A project team, a service Saturday, an intramural roster, or just the boba run. One is enough.",
  },
  {
    when: "Week four",
    title: "Bring a draft resume",
    body: "Line-by-line edits from recruiters and alumni at the workshop. Nothing here assumes you already have an internship.",
  },
] as const;

export type ChapterEvent = {
  title: string;
  /**
   * Wall-clock start in Atlanta, `YYYY-MM-DDTHH:mm`. Sorts the calendar and
   * decides upcoming vs. past — never hand-flip a flag again.
   */
  start: string;
  /** Overrides the formatted date when only the month is known ("Oct 2025"). */
  dateLabel?: string;
  location: string;
  body: string;
};

/** A ChapterEvent with its rendered date string resolved. */
export type DatedEvent = ChapterEvent & { displayDate: string };

// TODO: replace with the real calendar, or move to the database + tRPC.
export const events: ChapterEvent[] = [
  {
    title: "Fall Kickoff & General Body Meeting",
    start: "2026-08-28T18:00",
    location: "Klaus 1443",
    body: "Meet the board, learn what SASE GT does this year, and grab free food.",
  },
  {
    title: "Resume Workshop with Corporate Partners",
    start: "2026-09-11T18:30",
    location: "Scheller College of Business",
    body: "Bring a draft resume and get line-by-line feedback from recruiters and alumni.",
  },
  {
    title: "Mentor/Mentee Kickoff",
    start: "2026-09-25T19:00",
    location: "Student Center Ballroom",
    body: "Meet your SASE family and start the semester-long mentorship program.",
  },
  {
    title: "SASE National Convention",
    start: "2025-10-01T09:00",
    dateLabel: "Oct 2025",
    location: "Chicago, IL",
    body: "Our largest delegation yet attended career fair, workshops, and the Night of Culture.",
  },
  {
    title: "Taste of SASE",
    start: "2026-04-01T12:00",
    dateLabel: "Apr 2026",
    location: "Tech Green",
    body: "A cultural food festival celebrating the cuisines of our members' heritages.",
  },
];

/**
 * `start` is authored as Atlanta wall-clock time and parsed as UTC so the
 * rendered string is byte-identical on the server and in the browser.
 */
function startedAt(event: ChapterEvent) {
  return Date.parse(`${event.start}:00Z`);
}

const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const timeFormat = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

function withDisplayDate(event: ChapterEvent): DatedEvent {
  const at = new Date(startedAt(event));
  return {
    ...event,
    displayDate:
      event.dateLabel ?? `${dayFormat.format(at)} · ${timeFormat.format(at)}`,
  };
}

// Evaluated once per process — on a static build this is build time, which is
// the right granularity for a semester calendar.
const now = Date.now();

/** Soonest first. Render `displayDate`, never `start`. May be empty. */
export const upcomingEvents: DatedEvent[] = events
  .filter((event) => startedAt(event) >= now)
  .sort((a, b) => startedAt(a) - startedAt(b))
  .map(withDisplayDate);

/** Most recent first. Render `displayDate`, never `start`. */
export const pastEvents: DatedEvent[] = events
  .filter((event) => startedAt(event) < now)
  .sort((a, b) => startedAt(b) - startedAt(a))
  .map(withDisplayDate);

export type BoardMember = {
  /** Omitted while the seat is unannounced — render the role on its own. */
  name?: string;
  role: string;
  major: string;
  /** TODO: add the per-role chapter aliases once they are created. */
  email?: string;
};

// TODO: replace with the 2026-2027 executive board and add headshots to /public.
export const board: BoardMember[] = [
  { role: "President", major: "Computer Science" },
  { role: "Internal Vice President", major: "Industrial Engineering" },
  { role: "External Vice President", major: "Business Administration" },
  { role: "Treasurer", major: "Mechanical Engineering" },
  { role: "Secretary", major: "Biomedical Engineering" },
  { role: "Professional Development Chair", major: "Computer Engineering" },
  { role: "Marketing Chair", major: "Computational Media" },
  { role: "Web Development Chair", major: "Computer Science" },
];

export type SponsorTier = {
  tier: string;
  amount: string;
  perks: string[];
};

export const sponsorTiers: SponsorTier[] = [
  {
    tier: "Buzz",
    amount: "$5,000+",
    perks: [
      "Exclusive company info session and dinner",
      "Logo on chapter apparel and banner",
      "Priority access to the member resume book",
      "Named sponsor of a signature event",
    ],
  },
  {
    tier: "Gold",
    amount: "$2,500",
    perks: [
      "Company info session or technical workshop",
      "Logo on website and event slides",
      "Access to the member resume book",
    ],
  },
  {
    tier: "White",
    amount: "$1,000",
    perks: [
      "Logo on website",
      "Recruiting posts to our members",
      "Resume book access",
    ],
  },
];

// TODO: once real partners sign, add them here and give /sponsors a logo wall
// (next/image from /public/sponsors). Until then the page runs an invitation
// instead — an empty logo grid advertises that the chapter has no partners.
