/**
 * Page content for SASE @ Georgia Tech.
 *
 * Static copy only. The calendar used to live here as a hardcoded array with
 * Intl formatters and a module-scope `Date.now()`; it now comes from the
 * database the officer tools write to, via `~/data/chapter-events`, so this
 * module is pure data again.
 *
 * Board roster and contact-facing facts are taken from the chapter's public
 * site (sites.gatech.edu/gtsase). Sponsors stay empty until partners sign.
 */

/** Verified founding year; membership/access claims that do not invent counts. */
export const stats = [
  { value: "2007", label: "Chapter founded" },
  { value: "Free", label: "Membership" },
  { value: "Open", label: "To every major" },
] as const;

/**
 * Meeting schedule is announced week-to-week on the chapter feeds — the
 * public site does not publish a fixed day/time, so neither do we.
 */
export const meeting = {
  cadence: "During the semester",
  day: "Announced on Instagram & Discord",
  time: "Posted with each meeting",
  location: "Room announced with each meeting",
  /** One-sentence version for prose. */
  summary:
    "General body meetings during the semester. Day, time, and room go out on Instagram and Discord each week.",
} as const;

/** Ribbon under the hero — what a member actually gets, in six words or less. */
export const marqueeItems = [
  "SASE KIN",
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
    title: "SASE KIN",
    body: "Kin groups pairing first-years with upperclassmen and alumni in industry.",
    detail:
      "Every member who signs up is placed in a SASE KIN group: a small cluster of first- and second-years matched with upperclassmen, and where possible an alum in industry. Kin set their own rhythm — coffee between classes, resume passes before a deadline, someone to text when a semester goes sideways.",
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
    title: "Get placed in SASE KIN",
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

export type BoardMember = {
  /** Omitted while the seat is unannounced — render the role on its own. */
  name?: string;
  role: string;
  major: string;
  /** Per-role aliases when the chapter creates them. */
  email?: string;
};

/**
 * Current executive board as published on sites.gatech.edu/gtsase/about-us.
 * Co-roles share a title; the UI keys rows by name.
 */
export const board: BoardMember[] = [
  {
    name: "Alex Liu",
    role: "President",
    major: "B.S. Computer Science 2027",
  },
  {
    name: "Aamogh Sawant",
    role: "Vice President",
    major: "B.S. Computer Science 2027",
  },
  {
    name: "Kim Thai",
    role: "External Vice President",
    major: "B.S. Electrical Engineering 2027",
  },
  {
    name: "Julia Moy",
    role: "Secretary",
    major: "B.S. Materials Science and Engineering 2028",
  },
  {
    name: "Nathan Pothuganti",
    role: "Secretary",
    major: "B.S. Computer Science 2028",
  },
  {
    name: "Akhil Gopal",
    role: "Event Co-Director",
    major: "B.S. Computer Science and Math 2028",
  },
  {
    name: "Iris Song",
    role: "Event Co-Director",
    major: "B.S. Computer Engineering 2027",
  },
  {
    name: "Kevin Zhang",
    role: "Event Co-Director",
    major: "B.S. Computer Science 2027",
  },
  {
    name: "Tiffany Jia",
    role: "Marketing Director",
    major: "B.S. Computational Media 2027",
  },
];

type SponsorTier = {
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

// Once real partners sign, add them here and give /sponsors a logo wall
// (next/image from /public/sponsors). Until then the page runs an invitation
// instead — an empty logo grid advertises that the chapter has no partners.
