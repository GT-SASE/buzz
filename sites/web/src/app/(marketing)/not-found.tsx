import {
  NotFoundBody,
  notFoundMetadata,
} from "~/components/site/not-found-body";

export const metadata = notFoundMetadata;

/**
 * notFound() from a (marketing) page, such as an unpublished /[slug], renders
 * here inside the layout, which already mounts the nav, main and footer. The
 * root not-found would nest a second set inside them.
 */
export default function MarketingNotFound() {
  return <NotFoundBody />;
}
