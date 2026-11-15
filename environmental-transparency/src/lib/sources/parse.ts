/**
 * Deterministic parsing of retrieved sources: HTML → text, PDF → paged text, and
 * structure-aware parsers for CEQAnet and Legistar pages. No model involvement here.
 */

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&#176;": "°",
  "&deg;": "°",
  "&#233;": "é",
  "&eacute;": "é",
  "&ndash;": "–",
  "&mdash;": "—",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&sect;": "§",
  "&times;": "×",
  "&copy;": "©",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m] ?? m);
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Readable text from HTML: drops scripts/styles/nav chrome, keeps block structure as newlines. */
export function htmlToText(html: string): string {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/td|\/th)[^>]*>/gi, "$&\n");
  return decodeEntities(body.replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function htmlTitle(html: string): string | null {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripTags(h1[1]) || null;
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? stripTags(t[1]) || null : null;
}

/** PDF → text with `[page N]` markers so citations can carry page references. */
export async function pdfToText(buf: Buffer, maxPages = 60): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).slice(0, maxPages);
  return {
    text: pages.map((p, i) => `[page ${i + 1}]\n${p.replace(/[ \t]+/g, " ").trim()}`).join("\n\n"),
    pages: totalPages,
  };
}

// ---------------------------------------------------------------------------
// CEQAnet
// ---------------------------------------------------------------------------

export interface CeqaAttachment {
  url: string;
  title: string;
  group: string | null;
  sizeKb: number | null;
}

export interface CeqaContact {
  name: string | null;
  agency: string | null;
  title: string | null;
  types: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export interface CeqaPage {
  schNumber: string | null;
  title: string | null;
  contacts: CeqaContact[];
  fields: Record<string, string>;
  dates: Record<string, string>;
  coordinates: { lat: number; lng: number; raw: string } | null;
  attachments: CeqaAttachment[];
}

/** Converts `37°22'29.8"N 121°57'17.3"W` (or decimal) to signed decimal degrees. */
export function parseDmsPair(raw: string): { lat: number; lng: number } | null {
  const s = raw.replace(/[’′]/g, "'").replace(/[”″]/g, '"');
  const dms = [...s.matchAll(/(\d{1,3})\s*°\s*(\d{1,2}(?:\.\d+)?)\s*'\s*(\d{1,2}(?:\.\d+)?)?\s*"?\s*([NSEW])/gi)];
  if (dms.length >= 2) {
    const conv = (m: RegExpMatchArray) => {
      const v = Number(m[1]) + Number(m[2]) / 60 + Number(m[3] ?? 0) / 3600;
      return /[SW]/i.test(m[4]) ? -v : v;
    };
    const a = dms.find((m) => /[NS]/i.test(m[4]));
    const b = dms.find((m) => /[EW]/i.test(m[4]));
    if (a && b) return { lat: +conv(a).toFixed(6), lng: +conv(b).toFixed(6) };
  }
  const dec = s.match(/(-?\d{1,2}\.\d{3,})\s*[, ]\s*(-?\d{2,3}\.\d{3,})/);
  if (dec) return { lat: Number(dec[1]), lng: Number(dec[2]) };
  return null;
}

export function isCeqaNet(url: string) {
  return /^https:\/\/ceqanet\.(lci|opr)\.ca\.gov\//.test(url);
}

export function parseCeqaNet(html: string, pageUrl: string): CeqaPage {
  const fields: Record<string, string> = {};
  const dates: Record<string, string> = {};
  const contacts: CeqaContact[] = [];
  const contactStart = html.search(/<h2>\s*Contact Information/i);
  const contactEnd = html.search(/<h2>\s*Location/i);
  const re = /<strong>([^<]{2,80})<\/strong>\s*<\/div>\s*<div class="col[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<\/div>|<div class="row|<div class="col)/g;
  for (const m of html.matchAll(re)) {
    const label = stripTags(m[1]);
    const at = m.index ?? 0;
    if (contactStart >= 0 && at > contactStart && (contactEnd < 0 || at < contactEnd)) {
      const v = stripTags(m[2]) || null;
      if (label === "Name" || contacts.length === 0) {
        contacts.push({ name: null, agency: null, title: null, types: null, email: null, phone: null, address: null });
      }
      const c = contacts[contacts.length - 1];
      if (label === "Name") c.name = v;
      else if (label === "Agency Name") c.agency = v;
      else if (label === "Job Title") c.title = v;
      else if (label === "Contact Types") c.types = v;
      else if (label === "Email") c.email = v;
      else if (label === "Phone") c.phone = v;
      else if (label === "Address") c.address = v;
      continue;
    }
    if (fields[label]) continue;
    const t = m[2].match(/<time datetime="([^"]+)"/);
    if (t) dates[label] = t[1];
    const value = stripTags(m[2]);
    if (value && value.length < 4000) fields[label] = value;
  }
  const attachments: CeqaAttachment[] = [];
  for (const m of html.matchAll(/<a[^>]*href="(\/\d{10}(?:\/\d+)?\/Attachment\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const text = stripTags(m[2]);
    const size = text.match(/(\d+)\s*K\b/);
    attachments.push({
      url: new URL(m[1], pageUrl).toString(),
      title: text.replace(/\bPDF\b.*$/i, "").replace(/\s*\([^)]*$/, "").replace(/_/g, " ").trim() || "Attachment",
      group: null,
      sizeKb: size ? Number(size[1]) : null,
    });
  }
  const coordRaw = fields["Location Coordinates"] ?? fields["Coordinates"] ?? null;
  const coords = coordRaw ? parseDmsPair(coordRaw) : null;
  return {
    schNumber: fields["SCH Number"]?.match(/\d{10}/)?.[0] ?? pageUrl.match(/\/(\d{10})/)?.[1] ?? null,
    title: htmlTitle(html),
    contacts,
    fields,
    dates,
    coordinates: coords && coordRaw ? { ...coords, raw: coordRaw } : null,
    attachments,
  };
}

// ---------------------------------------------------------------------------
// Legistar
// ---------------------------------------------------------------------------

export interface LegistarPage {
  fileNumber: string | null;
  title: string | null;
  onAgenda: string | null;
  attachments: { url: string; title: string }[];
  meetingUrl: string | null;
}

export function isLegistar(url: string) {
  return /^https:\/\/[a-z]+\.legistar\.com\//.test(url);
}

export function parseLegistar(html: string, pageUrl: string): LegistarPage {
  const attachments = [...html.matchAll(/href="(View\.ashx\?M=F[^"]+)"[^>]*>([^<]*)</g)].map((m) => ({
    url: new URL(decodeEntities(m[1]), pageUrl).toString(),
    title: stripTags(m[2]) || "Attachment",
  }));
  const span = (id: string) => {
    const m = html.match(new RegExp(`id="[^"]*${id}"[^>]*>([\\s\\S]*?)</(span|a|td)>`));
    return m ? stripTags(m[1]) || null : null;
  };
  const meeting = html.match(/href="(MeetingDetail\.aspx\?[^"]+)"/);
  return {
    fileNumber: span("lblFile2"),
    title: span("lblTitle2"),
    onAgenda: span("lblOnAgenda2"),
    attachments,
    meetingUrl: meeting ? new URL(decodeEntities(meeting[1]), pageUrl).toString() : null,
  };
}

/** Ranks attachments so short notices (dates, comment instructions) are fetched first. */
export function attachmentPriority(title: string): number {
  const t = title.toLowerCase();
  if (/notice|noi|noa|nop|noc|nod|summary form|availability|project data/.test(t)) return 3;
  if (/staff report|report to|mitigated negative|initial study|executive summary/.test(t)) return 2;
  if (/comment|presentation|condition/.test(t)) return 1;
  if (/appendix|appendices|renderings|plans|zip/.test(t)) return -1;
  return 0;
}
