type IconProps = { className?: string };

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: "false",
} as const;

export function BriefcaseIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="2.5" y="7" width="19" height="13" rx="2" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
      <path d="M2.5 12.5h19" />
    </svg>
  );
}

export function CompassIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </svg>
  );
}

export function TerminalIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="m7 10 2.5 2L7 14M12.5 15h4.5" />
    </svg>
  );
}

export function HeartIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 20s-7.5-4.4-7.5-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.7C19.5 15.6 12 20 12 20Z" />
    </svg>
  );
}

export function CupIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M6 8h12l-1 11.2a2 2 0 0 1-2 1.8H9a2 2 0 0 1-2-1.8Z" />
      <path d="M9 8V5.5a3 3 0 0 1 6 0V8" />
      <path d="M10 13h.01M13.5 15.5h.01" />
    </svg>
  );
}

export function TrophyIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M7 4h10v5a5 5 0 0 1-10 0Z" />
      <path d="M7 5.5H4.5v1A3.5 3.5 0 0 0 7.6 10M17 5.5h2.5v1a3.5 3.5 0 0 1-3.1 3.5" />
      <path d="M12 14v3M9 20h6l-.5-3h-5Z" />
    </svg>
  );
}

export function CapIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M2.5 9 12 5l9.5 4-9.5 4z" />
      <path d="M6.5 11v4.5c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V11" />
      <path d="M21.5 9v5" />
    </svg>
  );
}

export function GlobeIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.2 9.5h17.6M3.2 14.5h17.6" />
      <path d="M12 3c2.4 2.4 3.6 5.4 3.6 9s-1.2 6.6-3.6 9c-2.4-2.4-3.6-5.4-3.6-9S9.6 5.4 12 3Z" />
    </svg>
  );
}

export function HandshakeIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="m3 12 3.5-3.5 4 1.5 2-1.5 2 1.5 4-1.5L22 12" />
      <path d="m10.5 10 2.8 2.8a1.4 1.4 0 0 1-2 2L9 12.5" />
      <path d="M6.5 8.5 3 12l3 3.5M18 8.5l3 3.5-3 3.5" />
    </svg>
  );
}

export function ArrowIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 12h16M14 6l6 6-6 6" />
    </svg>
  );
}

export const iconMap = {
  briefcase: BriefcaseIcon,
  compass: CompassIcon,
  terminal: TerminalIcon,
  heart: HeartIcon,
  cup: CupIcon,
  trophy: TrophyIcon,
  cap: CapIcon,
  globe: GlobeIcon,
  handshake: HandshakeIcon,
} as const;

export type IconName = keyof typeof iconMap;

export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) {
  const Component = iconMap[name];
  return <Component className={className} />;
}
