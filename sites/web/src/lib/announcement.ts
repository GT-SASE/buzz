/**
 * The site-wide banner as the public site reads it. Pure, so the mapping from
 * the stored row and the dismissal script are testable without a database; the
 * cached loader is `~/data/announcement`.
 */

export type Announcement = {
  message: string;
  link: { label: string; href: string } | null;
  /** Changes on every save; a visitor's dismissal is keyed on it. */
  version: string;
};

/**
 * The columns the banner is stored in, see `routers/announcement.ts`:
 * title is the message, description the link label, body the link target.
 */
export type AnnouncementRow = {
  title: string;
  description: string;
  body: string;
  published: boolean;
  updatedAt: Date;
};

/** The banner to show, or null when it is off or has nothing to say. */
export function announcementFromRow(row: AnnouncementRow): Announcement | null {
  if (!row.published) return null;
  const message = row.title.trim();
  if (message === "") return null;
  const label = row.description.trim();
  const href = row.body.trim();
  return {
    message,
    link: label !== "" && href !== "" ? { label, href } : null,
    version: String(row.updatedAt.getTime()),
  };
}

export const ANNOUNCEMENT_ELEMENT_ID = "site-announcement";
export const ANNOUNCEMENT_DISMISS_KEY = "sase-announcement-dismissed";

/**
 * Runs inline, right after the banner, so it executes before the first paint:
 * a visitor who dismissed this version never sees it flash, and nothing below
 * it moves. It also reveals the dismiss button, which stays hidden without
 * script because it would do nothing. Storage can throw (private windows,
 * blocked site data), and then the banner simply stays up.
 */
export const announcementScript = `(function(){var e=document.getElementById(${JSON.stringify(ANNOUNCEMENT_ELEMENT_ID)});if(!e)return;var k=${JSON.stringify(ANNOUNCEMENT_DISMISS_KEY)},v=e.getAttribute("data-version");try{if(localStorage.getItem(k)===v){e.hidden=true;return}}catch(_){}var b=e.querySelector("[data-dismiss]");if(!b)return;b.hidden=false;b.addEventListener("click",function(){e.hidden=true;try{localStorage.setItem(k,v)}catch(_){}})})()`;
