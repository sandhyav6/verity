import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const I = (d: string) => (p: P) => (
  <svg {...base} {...p}>
    <path d={d} />
  </svg>
);

export const IconCheck = I("M5 12.5l4.5 4.5L19 7.5");
export const IconX = I("M6 6l12 12M18 6L6 18");
export const IconAlert = I("M12 8v5m0 3.5v.01M10.3 3.9L2.6 17.5a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z");
export const IconInfo = I("M12 11v5m0-8.5v.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z");
export const IconCopy = I("M9 9h10v11H9zM5 15V4h10");
export const IconUpload = I("M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3");
export const IconFile = I("M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5");
export const IconExternal = I("M14 4h6v6m0-6L10 14M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5");
export const IconMenu = I("M4 7h16M4 12h16M4 17h16");
export const IconChevronDown = I("M6 9l6 6 6-6");
export const IconChevronRight = I("M9 6l6 6-6 6");
export const IconShield = I("M12 3l8 3v6c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V6z");
export const IconSearch = I("M11 18a7 7 0 100-14 7 7 0 000 14zm9 3l-4.5-4.5");
export const IconLayers = I("M12 3l9 5-9 5-9-5zm-9 9l9 5 9-5M3 16l9 5 9-5");
export const IconClock = I("M12 7v5l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z");
export const IconWallet = I("M4 7a2 2 0 012-2h12v4M4 7v10a2 2 0 002 2h13a1 1 0 001-1v-8a1 1 0 00-1-1H6a2 2 0 01-2-2zm12 6h2");
export const IconKey = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9m-3 3l3 3m-6-0l2 2" />
  </svg>
);
export const IconDownload = I("M12 4v12m0 0l-4.5-4.5M12 16l4.5-4.5M4 20h16");

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg {...base} className={`animate-spin ${className}`} role="status" aria-label="Loading">
      <path d="M12 3a9 9 0 109 9" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden className={className}>
      <rect width="32" height="32" rx="7" fill="currentColor" opacity=".16" />
      <path d="M9 16.5l4.5 4.5L23 11" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
