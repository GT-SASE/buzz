import Link from "next/link";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";

export function PageBreadcrumb({ current }: { current: string }) {
  return (
    <Breadcrumb className="mb-8">
      <BreadcrumbList className="text-ink-muted text-body-sm">
        <BreadcrumbItem>
          <BreadcrumbLink asChild className="hover:text-navy font-semibold">
            <Link href="/portal/admin/pages">All pages</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage className="text-navy font-semibold">
            {current}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
