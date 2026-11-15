/**
 * Map marker images rendered from Lucide icon paths (ISC license, same set as the UI's lucide-react icons),
 * so map markers and legends use identical glyphs.
 */
import { CATEGORY_STYLES, SCHOOL_COLOR } from "@/lib/client/gis";

const PATHS: Record<string, string> = {
  server:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  factory:
    '<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1"/><path d="M12 18h1"/><path d="M7 18h1"/>',
  warehouse:
    '<path d="M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z"/><path d="M6 18h12"/><path d="M6 14h12"/><rect width="12" height="12" x="6" y="10"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  building:
    '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  school:
    '<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>',
};

/** A circular badge (fill + white ring) with a white icon, drawn at 2× for crisp HiDPI rendering. */
function badgeSvg(icon: string, fill: string, size: number, stroke: string) {
  const r = size / 2 - 1.5;
  const iconPx = size * 0.5;
  const offset = (size - iconPx) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 ${size} ${size}">
<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
<g transform="translate(${offset},${offset}) scale(${iconPx / 24})" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${PATHS[icon]}</g></svg>`;
}

function load(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

export interface MarkerImage {
  id: string;
  image: HTMLImageElement;
}

export async function markerImages(): Promise<MarkerImage[]> {
  const jobs = Object.entries(CATEGORY_STYLES).map(async ([cat, s]) => ({ id: `cat-${cat}`, image: await load(badgeSvg(s.icon, s.color, 34, "#ffffff")) }));
  jobs.push(load(badgeSvg("school", SCHOOL_COLOR, 24, "#ffffff")).then((image) => ({ id: "school", image })));
  jobs.push(load(badgeSvg("school", "#b4462b", 26, "#ffffff")).then((image) => ({ id: "school-reported", image })));
  return Promise.all(jobs);
}

export const ICON_PATHS = PATHS;
