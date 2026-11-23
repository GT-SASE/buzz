import { AnnouncementBanner } from "~/components/site/announcement";
import { getAnnouncement } from "~/data/announcement";

/** The banner an officer has switched on, or nothing. Cached with the tag `announcement`. */
export async function AnnouncementSlot() {
  const announcement = await getAnnouncement();
  return announcement ? (
    <AnnouncementBanner announcement={announcement} />
  ) : null;
}
