/**
 * Deterministic relevance + status classification of CEQAnet project groups. No model involvement:
 * every decision records the rule and the exact text it matched, so the reason a project appears in
 * IMBY is itself traceable to the filing. Pure module.
 */
import type { ProjectCategory, ProjectStatus } from "@/types/project";
import type { CeqaFiling, ProjectGroup } from "@/lib/campaign/ceqa-feed";

export interface DevType {
  type: string;
  subtype: string | null;
  attrs: Record<string, number>;
  text: string;
}

/** "Commercial (Sq. Ft. 30163, Acres 23.82), Power:Solar (Megawatts 2000)" → structured entries. */
export function parseDevelopmentTypes(s: string | null): DevType[] {
  if (!s) return [];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map((text) => {
    // "Type:Subtype (Label)(Attr 1, Attr 2)": every parenthetical group is read.
    const head = text.split("(")[0];
    const [type, sub] = head.split(":").map((x) => x.trim());
    const attrs: Record<string, number> = {};
    const labels: string[] = [];
    for (const g of text.matchAll(/\(([^()]*)\)/g)) {
      for (const a of g[1].split(",")) {
        const kv = a.trim().match(/^(.+?)\s+(-?[\d.]+)$/);
        if (kv && Number.isFinite(Number(kv[2]))) attrs[kv[1].trim()] = Number(kv[2]);
        else if (a.trim()) labels.push(a.trim());
      }
    }
    const subtype = [sub, ...labels].filter(Boolean).join(" — ") || null;
    return { type: type || text.trim(), subtype, attrs, text };
  });
}

/** CEQA document type → procedural status of the project as of that filing. */
export function statusFromDocType(docType: string): ProjectStatus {
  const t = docType.trim().toUpperCase();
  if (/^(NOD|NOE|ROD)$/.test(t)) return "approved"; // filed after the agency's decision
  if (/^(CON|NOI)$/.test(t)) return "proposed";
  if (/^(NOP|EIR|MND|NEG|ND|IS|SIR|SBE|SCA|RIR|REV|FIN|EA|EIS|JD|RC|ADM|NOC|FED|MEA)$/.test(t)) return "under_review";
  return "unknown";
}

/**
 * Keyword rules. `any` patterns count wherever they appear (descriptions score lower than titles);
 * `titleOnly` patterns are too generic in descriptions ("serves industrial customers",
 * "located along Capitol Expressway") and only count in a filing title.
 */
const RULES: { category: ProjectCategory; weight: number; any: RegExp; titleOnly?: RegExp }[] = [
  { category: "data_center", weight: 10, any: /\bdata[- ]?cent(?:er|re)s?\b|\bhyperscale\b|\bserver farm\b|\bcolocation facilit|\bdata campus\b/i },
  {
    category: "power_infrastructure",
    weight: 7,
    any: /\bsubstation\b|\btransmission (?:line|project)s?\b|\bgen[- ]?tie\b|\bgenerat(?:ing|ion) (?:station|facility|plant)\b|\bpower plant\b|\bbattery energy storage\b|\bBESS\b|\benergy storage (?:system|facility|project)s?\b|\bsolar (?:farm|facility|project|energy (?:facility|project|center|generation))\b|\bwind (?:energy|farm|project|repower)\b|\bgeothermal (?:plant|power|facility|project)\b|\bhydrogen (?:production|plant|hub)\b|\bpeaker\b|\bhydroelectric\b|\bpumped storage\b|\buprate\b|\bmegawatts?\b|\bMW\b/i,
    titleOnly: /\bsolar\b|\bphotovoltaic\b|\bbattery storage\b|\benergy storage\b|\bfuel cells?\b|\bmicrogrid\b|\bpower (?:plant|station|project)\b/i,
  },
  {
    category: "warehouse_logistics",
    weight: 6,
    any: /\b(?:speculative|distribution|logistics|e-?commerce|high[- ]cube) (?:warehouse|center|facility|building)s?\b|\bdistribution (?:center|facility|warehouse)s?\b|\bfulfillment (?:center|facility)\b|\bcold storage (?:facility|warehouse)\b|\btruck (?:terminal|yard|stop)s?\b|\bintermodal\b|\btravel (?:center|plaza)\b|\bwarehouses? (?:building|space|use|development)s?\b/i,
    titleOnly: /\bwarehouses?\b|\blogistics\b|\bfulfillment\b|\bindustrial park\b|\bbusiness park\b|\bcommerce (?:center|park)\b/i,
  },
  {
    category: "industrial",
    weight: 5,
    any: /\bmanufacturing (?:facility|plant|building|operations?)\b|\brefiner(?:y|ies)\b|\bprocessing (?:plant|facility)\b|\blandfill\b|\b(?:recycling|composting|compost|transfer) (?:facility|station|operation)\b|\bmaterials recovery\b|\bbiomass (?:plant|facility|power)\b|\bcement (?:plant|kiln)\b|\bquarry\b|\bsurface min(?:e|ing)\b|\basphalt (?:plant|batch)|\bconcrete batch|\bchemical (?:plant|facility)|\bfoundry\b|\bsmelter\b|\bbiogas (?:facility|plant)\b|\brenewable (?:diesel|natural gas|fuels?) (?:facility|plant|project)\b|\bwaste[- ]to[- ]energy\b|\bdesalination (?:plant|facility|project)\b/i,
    titleOnly: /\bindustrial\b|\bmanufactur|\bdesalination\b|\bbatch plant\b|\bmine\b|\bmining\b/i,
  },
  {
    category: "transportation",
    weight: 5,
    any: /\b(?:toll|express|managed|HOV) lanes? (?:project|conversion|extension)\b|\bhigh[- ]speed rail\b|\bbus rapid transit\b|\bgrade separation\b|\b(?:freeway|highway|interstate|expressway) (?:widening|extension|expansion|realignment)\b/i,
    titleOnly: /\bfreeway\b|\binterchange\b|\bexpressway\b|\blight rail\b|\bcommuter rail\b|\brail (?:line|yard|corridor|extension|terminal|facility)\b|\btransit (?:center|extension|corridor)\b|\bairport(?! land use)\b|\brunway\b|\bseaport\b|\bmarine terminal\b|\bport of\b|\bwidening\b|\bnew (?:road|roadway|highway)\b/i,
  },
];

/** Policy actions and plans are not developments (e.g. data-center moratoria, zoning text amendments). */
const POLICY_TITLE = /\bmoratori(?:um|a)\b|\bprohibition on\b|\b(?:proposed )?regulations\b|\b(?:\d{4} )?general plan(?: \d{4})?\s*$|\bgeneral lease\b|\bamendment of (?:general )?lease\b|\blease (?:amendment|renewal|extension)\b|\bordinance\b|\b(?:zoning|code|text|municipal code|title \d+)[^.]{0,30}amendments?\b|\bamendments? to (?:the )?(?:\w+ )?(?:municipal |zoning )?(?:code|title|ordinance)|\bhousing element\b|\bclimate action plan\b|\bgeneral plan update\b|\blocal coastal program\b|\bsphere of influence\b|\bmunicipal service review\b|\bannexation\b|\bfee (?:study|program)\b/i;
/** Routine or minor work that should not be indexed unless a strong development signal also matches. */
const MINOR = /\bmaintenance\b|\brepairs?\b|\breplacements?\b|\bupgrades?\b|\bemergency\b|\bcondition assessment\b|\bretrofit\b|\brehabilitation\b|\bculverts?\b|\bpavement\b|\bresurfac|\boverlay\b|\bguardrail\b|\bADA\b|\bcurb ramps?\b|\bsidewalks?\b|\bstriping\b|\bstorm damage\b|\bslope (?:repair|stabiliz)|\bvegetation\b|\bfuel (?:break|reduction)\b|\bdrainage improvements?\b|\bsign(?:s|age) (?:replacement|upgrade)|\blighting (?:upgrade|replacement)|\bwell replacement\b|\btank replacement\b|\bwater main\b|\bsewer (?:main|lateral)|\bpipeline replacement\b|\brestoration\b|\btrail\b|\b(?<!industrial |business |commerce |technology |logistics |research |solar |wind |energy )park\b|\bcannabis\b|\bsingle[- ]family\b|\baccessory dwelling\b/i;
/** Development types from the Notice of Completion that indicate IMBY-relevant land uses. */
const DEV_TYPE_CATEGORY: Record<string, ProjectCategory> = {
  Industrial: "industrial",
  Power: "power_infrastructure",
  "Waste Treatment": "industrial",
  "Hazardous Waste": "industrial",
  Mining: "industrial",
  Transportation: "transportation",
};

export interface Classification {
  relevant: boolean;
  category: ProjectCategory;
  status: ProjectStatus;
  /** proposed or under active review (the campaign's priority set). */
  active: boolean;
  score: number;
  reasons: { rule: string; matched: string; docUrl: string }[];
  excludedBecause: string | null;
  devTypes: DevType[];
  latest: CeqaFiling;
  /** Filing whose structured fields describe the project best (latest Notice of Completion–type filing). */
  primary: CeqaFiling;
}

/** "would not include … data centers", "no warehouse", "excluding logistics": a mention that is negated. */
const NEGATION = /\b(?:not|no|never|without|exclud(?:e|es|ed|ing)|prohibit(?:s|ed|ing)?|other than|neither|nor)\b[^.;:]*$/i;

/** First match of `re` in `text` that is not negated earlier in the same clause. */
export function firstAffirmed(re: RegExp, text: string): RegExpExecArray | null {
  const g = new RegExp(re.source, "gi");
  for (let m = g.exec(text); m; m = g.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 80), m.index);
    if (!NEGATION.test(before)) return m;
  }
  return null;
}

const snippet = (text: string, m: RegExpExecArray) => {
  const a = Math.max(0, m.index - 60);
  return `${a > 0 ? "…" : ""}${text.slice(a, m.index + m[0].length + 60).replace(/\s+/g, " ").trim()}${m.index + m[0].length + 60 < text.length ? "…" : ""}`;
};

export function classifyProject(g: ProjectGroup, today = new Date().toISOString().slice(0, 10)): Classification {
  const latest = g.filings[g.filings.length - 1];
  const primary = [...g.filings].reverse().find((f) => f.developmentTypes || f.coordinatesRaw) ?? latest;
  const devTypes = parseDevelopmentTypes(primary.developmentTypes);
  const status = statusFromDocType(latest.docType);
  const reasons: Classification["reasons"] = [];
  const scores = new Map<ProjectCategory, number>();
  const add = (c: ProjectCategory, w: number) => scores.set(c, Math.max(scores.get(c) ?? 0, w));

  const titles = [...new Set(g.filings.map((f) => f.projectTitle || f.docTitle))].join(" | ");
  const texts = [
    { label: "title", text: titles, url: latest.portalUrl },
    ...g.filings.slice(-3).map((f) => ({ label: `${f.docType} description`, text: f.description, url: f.portalUrl })),
  ];
  const titleHits = new Set<ProjectCategory>();
  for (const rule of RULES) {
    for (const t of texts) {
      const isTitle = t.label === "title";
      const m = firstAffirmed(rule.any, t.text) ?? (isTitle && rule.titleOnly ? firstAffirmed(rule.titleOnly, t.text) : null);
      if (m) {
        // Title matches are strong evidence; a passing mention in a description is weaker.
        add(rule.category, isTitle ? rule.weight + 2 : rule.weight - 3);
        if (isTitle) titleHits.add(rule.category);
        reasons.push({ rule: `${rule.category} keyword (${t.label})`, matched: snippet(t.text, m), docUrl: t.url });
        break;
      }
    }
  }
  // A state-route or interstate title is major only when the agency is preparing an EIR for it.
  const eirLevel = g.filings.some((f) => /^(NOP|EIR|FIN|SIR|SBE|RIR|EIS|JD)$/.test(f.docType));
  const route = /\b(?:I|SR|US)[- ]?\d{1,3}\b|\b(?:state route|interstate|highway) \d+\b/i.exec(titles);
  if (route && eirLevel) {
    add("transportation", 7);
    reasons.push({ rule: "transportation route project with an EIR", matched: snippet(titles, route), docUrl: latest.portalUrl });
  }
  let devScore = 0;
  let devCategory: ProjectCategory | null = null;
  for (const d of devTypes) {
    const c = DEV_TYPE_CATEGORY[d.type];
    if (!c) continue;
    reasons.push({ rule: `NOC development type "${d.type}"`, matched: d.text, docUrl: primary.portalUrl });
    // NOC transportation types include routine road work, so they only support a keyword match.
    if (c === "transportation") continue;
    if (6 > devScore) {
      devScore = 6;
      devCategory = c;
    }
  }

  // Category: the most specific keyword evidence wins; the generic NOC development type is the fallback.
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const category: ProjectCategory = ranked[0]?.[0] ?? devCategory ?? "other";
  let score = Math.max(ranked[0]?.[1] ?? 0, devScore + (devCategory && scores.has(devCategory) ? 1 : 0));
  let excludedBecause: string | null = null;

  const latestTitle = latest.projectTitle || latest.docTitle;
  const strong = (scores.get("data_center") ?? 0) >= 7 || titleHits.has("data_center") || titleHits.has("power_infrastructure");
  const majorWork = /\bwidening\b|\binterchange\b|\bnew\b|\bexpansion\b|\bfreeway upgrade\b/i.test(latestTitle);
  const exemptOnly = g.filings.every((f) => f.docType === "NOE");
  if (POLICY_TITLE.test(latestTitle) || POLICY_TITLE.test(g.filings[0].docTitle)) {
    excludedBecause = "Policy, ordinance, or plan action rather than a specific development";
  } else if (score < 5) {
    excludedBecause = ranked.length || devScore ? "Only a passing mention of a relevant use; no title, development-type, or specific-facility signal" : "No IMBY-relevant development signal in titles, descriptions, or development types";
  } else if (MINOR.test(latestTitle) && !majorWork && (!strong || exemptOnly)) {
    excludedBecause = "Routine or minor work (maintenance, repair, replacement, upgrade, etc.)";
  } else if (exemptOnly && !((scores.get("data_center") ?? 0) >= 7)) {
    // An exemption means the agency found no CEQA review was needed; only data centers are kept.
    excludedBecause = "Only a Notice of Exemption on file (exempt from CEQA review) and not a data center";
  }

  const withdrawn = /^\W*withdrawn\b/i.test(latestTitle);
  const effectiveStatus: ProjectStatus = withdrawn ? "withdrawn" : status;
  const active = effectiveStatus === "proposed" || effectiveStatus === "under_review";
  const publicEnd = [...g.filings].reverse().find((f) => f.publicReview.end)?.publicReview.end ?? null;
  if (!excludedBecause) {
    if (active) score += 5;
    if (publicEnd && publicEnd >= today) score += 6;
    if (g.filings.some((f) => /^(EIR|MND|NEG|FIN|SIR)$/.test(f.docType))) score += 2;
    const mw = devTypes.reduce((s, d) => s + (d.attrs.Megawatts ?? 0), 0);
    const sqft = devTypes.reduce((s, d) => s + (d.attrs["Sq. Ft."] ?? 0), 0);
    if (mw >= 20 || sqft >= 100_000) score += 2;
  }
  return { relevant: !excludedBecause, category, status: effectiveStatus, active, score: excludedBecause ? 0 : score, reasons, excludedBecause, devTypes, latest, primary };
}
