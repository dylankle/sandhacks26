"use client";

import Image from "next/image";
import { useId, useMemo, useState } from "react";
import { ArrowRight, MapPin } from "lucide-react";
import { Spinner } from "@/components/ui";
import { placeLabel, resolvePlace, suggestPlaces, type Place } from "@/lib/client/places";
import type { ProjectSummary } from "@/types/project";

interface Props {
  projects: ProjectSummary[] | null;
  places: Place[] | null;
  onPlace: (p: Place) => void;
  onStatewide: () => void;
}

function Stat({ value, label, accent }: { value: number | null; label: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-panel px-4 py-3.5">
      <p className={`font-serif text-[30px] leading-none tracking-tight ${accent ? "text-open" : ""}`}>{value === null ? <span className="inline-block h-7 w-12 animate-pulse rounded bg-black/[0.06]" /> : value.toLocaleString()}</p>
      <p className="mt-1.5 text-[12px] leading-snug text-ink-3">{label}</p>
    </div>
  );
}

/** First screen: what IMBY is, what it tracks, and where the reader wants to look. */
export default function Landing({ projects, places, onPlace, onStatewide }: Props) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();

  const stats = useMemo(() => {
    if (!projects) return null;
    const counties = new Set(projects.flatMap((p) => [...(p.jurisdiction ?? "").matchAll(/([A-Z][\w .'-]+?) County/g)].map((m) => m[1].trim())));
    return {
      total: projects.length,
      open: projects.filter((p) => p.comment_status === "open").length,
      mapped: projects.filter((p) => p.latitude !== null).length,
      counties: counties.size,
    };
  }, [projects]);

  const suggestions = useMemo(() => (places ? suggestPlaces(text, places) : []), [text, places]);

  const choose = (p: Place) => {
    setError(null);
    setOpen(false);
    onPlace(p);
  };
  const submit = () => {
    if (!places) return;
    const hit = (open && suggestions[active]) || resolvePlace(text, places);
    if (hit) choose(hit);
    else setError(text.trim() ? `We couldn't find "${text.trim()}" among California cities, communities, or counties.` : "Enter a California city or county.");
  };

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-paper">
      <div className="mx-auto flex min-h-full max-w-2xl flex-col px-4 pb-10 pt-6 sm:px-6">
        <div className="flex items-center gap-2.5">
          <Image src="/imby-logo.png" alt="" width={32} height={32} className="size-8" priority />
          <span className="font-serif text-[21px] tracking-tight">IMBY</span>
        </div>

        <main className="flex flex-1 flex-col justify-center py-10">
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">California · official records, mapped</p>
          <h1 className="mt-3 text-balance font-serif text-[44px] leading-[1.04] tracking-tight sm:text-[56px]">What&apos;s being built near you</h1>
          <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-ink-2">
            Data centers, power plants, industrial sites, warehouses, and major transportation projects under environmental review across California. Every figure traces back to an official public
            record, so you can see what&apos;s proposed, where it stands, and how to have your say.
          </p>

          <div className="mt-8 grid grid-cols-2 gap-2.5 sm:grid-cols-4" aria-label="Developments tracked">
            <Stat value={stats?.total ?? null} label="developments tracked" />
            <Stat value={stats?.open ?? null} label="open for public comment" accent />
            <Stat value={stats?.mapped ?? null} label="with a verified map location" />
            <Stat value={stats?.counties ?? null} label="counties covered" />
          </div>

          <form
            className="mt-9"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label htmlFor={`${listId}-input`} className="text-[14px] font-semibold">
              Where do you live?
            </label>
            <div className="relative mt-2">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <MapPin className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-ink-3" />
                  <input
                    id={`${listId}-input`}
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      setActive(0);
                      setOpen(true);
                      setError(null);
                    }}
                    onKeyDown={(e) => {
                      if (!suggestions.length) return;
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setOpen(true);
                        setActive((a) => (a + 1) % suggestions.length);
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
                      } else if (e.key === "Escape") setOpen(false);
                    }}
                    onBlur={() => setTimeout(() => setOpen(false), 120)}
                    placeholder="City or county, e.g. San Jose or Kern County"
                    autoComplete="off"
                    autoFocus
                    role="combobox"
                    aria-expanded={open && suggestions.length > 0}
                    aria-controls={`${listId}-list`}
                    aria-activedescendant={open && suggestions[active] ? `${listId}-opt-${active}` : undefined}
                    aria-invalid={!!error}
                    aria-describedby={error ? `${listId}-error` : undefined}
                    className="h-14 w-full rounded-full border border-line-2 bg-panel pl-12 pr-4 text-[16px] shadow-sm outline-none transition focus:border-ink-3"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!places}
                  className="inline-flex h-14 shrink-0 items-center gap-2 rounded-full bg-ink px-5 text-[15px] font-semibold text-white transition hover:bg-ink/85 disabled:opacity-60"
                >
                  {places ? <ArrowRight className="size-5" /> : <Spinner className="size-4" />}
                  <span className="hidden sm:inline">Show projects</span>
                </button>
              </div>
              {open && suggestions.length > 0 && (
                <ul id={`${listId}-list`} role="listbox" className="absolute left-0 right-0 top-[60px] z-10 overflow-hidden rounded-2xl border border-line bg-panel py-1 shadow-xl sm:right-[150px]">
                  {suggestions.map((p, i) => (
                    <li
                      key={`${p.kind}-${p.geoid}`}
                      id={`${listId}-opt-${i}`}
                      role="option"
                      aria-selected={i === active}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setText(placeLabel(p));
                        choose(p);
                      }}
                      onMouseEnter={() => setActive(i)}
                      className={`flex cursor-pointer items-center justify-between px-4 py-2.5 text-[14px] ${i === active ? "bg-paper" : ""}`}
                    >
                      <span>{p.name}</span>
                      <span className="text-[12px] text-ink-3">{p.kind === "county" ? "County" : p.kind === "city" ? "City" : "Community"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {error && (
              <p id={`${listId}-error`} role="alert" className="mt-2.5 px-1 text-[13px] text-red-700">
                {error}
              </p>
            )}
          </form>
          <button onClick={onStatewide} className="mt-4 self-start px-1 text-[13px] font-medium text-ink-2 underline decoration-line-2 underline-offset-4 hover:text-ink">
            Or browse all of California
          </button>
        </main>

        <p className="text-[11px] leading-relaxed text-ink-3">
          Sources: CEQAnet (State Clearinghouse), agency and city records, U.S. Census place and county boundaries. IMBY points to official channels and never submits anything on your behalf.
        </p>
      </div>
    </div>
  );
}
