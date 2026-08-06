import {
  Briefcase,
  Compass,
  CupSoda,
  Globe,
  GraduationCap,
  Handshake,
  Heart,
  Terminal,
  Trophy,
  type LucideIcon,
} from "lucide-react";

export const iconMap = {
  briefcase: Briefcase,
  compass: Compass,
  terminal: Terminal,
  heart: Heart,
  cup: CupSoda,
  trophy: Trophy,
  cap: GraduationCap,
  globe: Globe,
  handshake: Handshake,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof iconMap;

export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) {
  const Component = iconMap[name];
  return <Component className={className} aria-hidden="true" />;
}
