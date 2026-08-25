/**
 * Public archive. Sourced from Engage, the chapter site, campus calendar, and
 * SASE national pages — not from the officer tools, which only hold events
 * members can still check into.
 *
 * Canceled listings and one-off rumors stay out. The featured set is the
 * chapter's signature nights: banquet, national conference, GT-hosted SERC,
 * and the trips people still talk about.
 */

export type ArchiveEvent = {
  title: string;
  displayDate: string;
  location: string | null;
  description: string | null;
};

export type FeaturedEvent = ArchiveEvent & {
  photo: "soiree" | "connect" | "nationals" | "hawks" | "serc" | "festival";
};

export const featuredPastEvents: FeaturedEvent[] = [
  {
    title: "Spring Soirée Banquet",
    displayDate: "Apr 10, 2026",
    location: "Bill Moore Student Success Center",
    description:
      "The spring banquet with Soiree — President's Suites, lobby, and atrium.",
    photo: "soiree",
  },
  {
    title: "SASE Connect 2024",
    displayDate: "Oct 9–12, 2024",
    location: "Boston",
    description:
      "The national conference, then a chapter day in Chinatown.",
    photo: "connect",
  },
  {
    title: "SASE National Conference 2023",
    displayDate: "Oct 11–14, 2023",
    location: "Georgia World Congress Center, Atlanta",
    description:
      "Nationals on home turf — GWCC and the Omni at CNN Center.",
    photo: "nationals",
  },
  {
    title: "Atlanta Hawks courtside",
    displayDate: "Mar 27, 2024",
    location: "State Farm Arena",
    description: "Fan night on the floor. Hawks vs. the Blazers.",
    photo: "hawks",
  },
  {
    title: "SERC 2019 — Ignite Your Dreams",
    displayDate: "Feb 23, 2019",
    location: "Molecular Science and Engineering Building",
    description:
      "The Southeast Regional Conference, hosted here at Georgia Tech.",
    photo: "serc",
  },
  {
    title: "Mid-Autumn × Halloween Festival",
    displayDate: "Oct 22, 2025",
    location: "LLC West Commons",
    description: "Lanterns and costumes in the same week, on Curran.",
    photo: "festival",
  },
];

export const pastEventYears: { year: string; events: ArchiveEvent[] }[] = [
  {
    year: "2026",
    events: [
      {
        title: "National Conference info + destress coloring",
        displayDate: "Apr 28, 2026",
        location: "IC 211",
        description: "Cookies, coloring, and the last NC briefing of the spring.",
      },
      {
        title: "April GBM and NC informational",
        displayDate: "Apr 13, 2026",
        location: "Klaus 1443",
        description: null,
      },
      {
        title: "SASE × Convexity — From Problem to Product",
        displayDate: "Apr 3, 2026",
        location: "Van Leer E283",
        description: "How startups actually begin.",
      },
      {
        title: "Sublimation printing workshop",
        displayDate: "Apr 1, 2026",
        location: "MILL Makerspace",
        description: "Custom mugs.",
      },
      {
        title: "SASE × Exxon speaker event",
        displayDate: "Mar 17, 2026",
        location: "John Lewis Student Center, Stamps Commons",
        description: null,
      },
      {
        title: "March GBM, disk painting",
        displayDate: "Mar 16, 2026",
        location: "College of Computing 017",
        description: null,
      },
      {
        title: "Cinema social — Kung Fu Panda 2",
        displayDate: "Mar 13, 2026",
        location: "IC 105",
        description: null,
      },
      {
        title: "Lunar New Year celebration",
        displayDate: "Feb 19, 2026",
        location: "Van Leer C340",
        description: null,
      },
      {
        title: "Learn to vibe-code with SASE",
        displayDate: "Feb 12, 2026",
        location: "College of Computing 016",
        description: null,
      },
      {
        title: "Become a LinkedIn Warrior",
        displayDate: "Feb 2, 2026",
        location: "College of Computing 017",
        description: null,
      },
      {
        title: "SERC 2026",
        displayDate: "Jan 17, 2026",
        location: "UCF, Orlando",
        description: "Southeast Regional Conference.",
      },
    ],
  },
  {
    year: "2025",
    events: [
      {
        title: "November/December GBM and destress",
        displayDate: "Dec 3, 2025",
        location: "Klaus 1447",
        description: null,
      },
      {
        title: "SASE × AOE mock interviews",
        displayDate: "Nov 7, 2025",
        location: "Bill Moore SSC, President’s Room B",
        description: null,
      },
      {
        title: "SASE × MILL tote-bag sublimation",
        displayDate: "Nov 5, 2025",
        location: "Love 176",
        description: null,
      },
      {
        title: "STEM Connect 2025",
        displayDate: "Oct 2–4, 2025",
        location: "Pittsburgh",
        description: null,
      },
      {
        title: "Spill the Tea",
        displayDate: "Sep 24, 2025",
        location: "West Architecture 258",
        description: null,
      },
      {
        title: "Public speaking and career fair prep",
        displayDate: "Sep 4, 2025",
        location: "Skiles 002",
        description: null,
      },
      {
        title: "First Spring Soirée",
        displayDate: "Apr 10, 2025",
        location: "Ferst Theater Lobby",
        description: "The first year of the banquet.",
      },
      {
        title: "Careers in Science — Dr. Jain",
        displayDate: "Apr 3, 2025",
        location: "Howey S104",
        description: "Science Week speaker.",
      },
      {
        title: "Make your own bioluminescent lava lamp",
        displayDate: "Apr 2, 2025",
        location: null,
        description: "Science Week.",
      },
      {
        title: "March GBM, Asian crafts night",
        displayDate: "Mar 24, 2025",
        location: "Mason 5134",
        description: null,
      },
      {
        title: "SERC 2025",
        displayDate: "Mar 15, 2025",
        location: "USF, Tampa",
        description: null,
      },
      {
        title: "Donaldson panel",
        displayDate: "Mar 3, 2025",
        location: "LLC West Commons",
        description: null,
      },
      {
        title: "February GBM × Cubing Club",
        displayDate: "Feb 24, 2025",
        location: "Van Leer C456",
        description: null,
      },
      {
        title: "SASE × FSA career fair prep",
        displayDate: "Jan 23, 2025",
        location: "Exhibition Hall, Centennial Room",
        description: null,
      },
      {
        title: "January GBM, trivia night",
        displayDate: "Jan 15, 2025",
        location: "Skiles 168",
        description: null,
      },
      {
        title: "Asian game night",
        displayDate: "Jan 7, 2025",
        location: "Mason 5134",
        description: null,
      },
    ],
  },
  {
    year: "2024",
    events: [
      {
        title: "December GBM, karaoke and destress",
        displayDate: "Dec 4, 2024",
        location: "Klaus 1447",
        description: null,
      },
      {
        title: "Cards Against SASE",
        displayDate: "Nov 19, 2024",
        location: "LLC West Commons",
        description: "Freshman-rep signature event.",
      },
      {
        title: "November GBM, Asian Family Feud",
        displayDate: "Nov 14, 2024",
        location: "Howey S104",
        description: "Thanksgiving cookies.",
      },
      {
        title: "Birthday celebration",
        displayDate: "Nov 8, 2024",
        location: "Kendeda 210",
        description: null,
      },
      {
        title: "Public speaking workshop",
        displayDate: "Nov 7, 2024",
        location: "Mason 5134",
        description: null,
      },
      {
        title: "Diwali celebration",
        displayDate: "Nov 4, 2024",
        location: "Tech Green",
        description: null,
      },
      {
        title: "GTIA Night Market table",
        displayDate: "Oct 24, 2024",
        location: "Tech Green",
        description: "Chinese calligraphy.",
      },
      {
        title: "October GBM, sushi-making",
        displayDate: "Oct 17, 2024",
        location: "Mason 5134",
        description: null,
      },
      {
        title: "Exelon online panel",
        displayDate: "Oct 4, 2024",
        location: "College of Computing 101",
        description: null,
      },
      {
        title: "Software development workshop",
        displayDate: "Oct 1, 2024",
        location: "East Architecture 309",
        description: "Excel.",
      },
      {
        title: "Apply-A-Thon",
        displayDate: "Sep 16, 2024",
        location: "Van Leer C341",
        description: null,
      },
      {
        title: "Professional headshots",
        displayDate: "Sep 13, 2024",
        location: "Harrison Square",
        description: null,
      },
      {
        title: "Career prep and resume review GBM",
        displayDate: "Sep 5, 2024",
        location: "Mason 5134",
        description: "First GBM of the year.",
      },
      {
        title: "Cookie decorating and lantern making",
        displayDate: "Sep 4, 2024",
        location: "Exhibition Hall, Highlands Room",
        description: "Mid-Autumn.",
      },
      {
        title: "Week of Welcome — make your vision board",
        displayDate: "Aug 14, 2024",
        location: "Exhibition Hall, Centennial Room",
        description: null,
      },
      {
        title: "Lockheed Martin lunch and learn",
        displayDate: "Apr 12, 2024",
        location: "Exhibition Hall, Inman Park Room",
        description: "Ben Phan.",
      },
      {
        title: "Science Week social — Interstellar",
        displayDate: "Apr 5, 2024",
        location: "Clough 123",
        description: null,
      },
      {
        title: "Movie night — 3 Idiots",
        displayDate: "Mar 8, 2024",
        location: "Skiles 002",
        description: null,
      },
      {
        title: "GE Aerospace info and networking",
        displayDate: "Feb 22, 2024",
        location: "Exhibition Hall, Cabbagetown Boardroom",
        description: null,
      },
      {
        title: "Valentine’s × Lunar New Year",
        displayDate: "Feb 16, 2024",
        location: "Exhibition Hall, Buckhead Room",
        description: "Orange peeling, paper dragon, origami.",
      },
      {
        title: "Professional headshots",
        displayDate: "Jan 28, 2024",
        location: "Tech Tower",
        description: null,
      },
      {
        title: "SERC 2024",
        displayDate: "Jan 13, 2024",
        location: "UF Reitz Union, Gainesville",
        description: null,
      },
    ],
  },
  {
    year: "2023",
    events: [
      {
        title: "Indian snack sale, Spirit Week",
        displayDate: "Nov 10, 2023",
        location: "Tech Green",
        description: "Proceeds to the Atlanta Humane Society.",
      },
      {
        title: "Public speaking workshop, Spirit Week",
        displayDate: "Nov 9, 2023",
        location: "Howey N210",
        description: null,
      },
      {
        title: "16th birthday celebration",
        displayDate: "Nov 8, 2023",
        location: "Skiles 246",
        description: null,
      },
      {
        title: "Apply-A-Thon",
        displayDate: "Oct 26, 2023",
        location: "Howey N210",
        description: null,
      },
      {
        title: "Professional development and boba social",
        displayDate: "Oct 4, 2023",
        location: "Howey S105A",
        description: "Elevator pitch with GTRI alumni, then Möge Tee.",
      },
    ],
  },
  {
    year: "2019 and earlier",
    events: [
      {
        title: "GT SASE kickoff",
        displayDate: "Aug 27, 2019",
        location: "IC 209",
        description: null,
      },
      {
        title: "Sandia National Laboratories tech talk",
        displayDate: "Apr 5, 2018",
        location: "IC 111",
        description: null,
      },
      {
        title: "TVA info session and workshop",
        displayDate: "Feb 26, 2018",
        location: "IC 111",
        description: null,
      },
      {
        title: "SERC, hosted at Georgia Tech",
        displayDate: "2017",
        location: "Georgia Tech",
        description: "The other year the regional conference came here.",
      },
    ],
  },
];
