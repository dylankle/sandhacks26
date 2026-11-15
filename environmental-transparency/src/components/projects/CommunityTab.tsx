"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink, HelpCircle, MessageSquareText, Search } from "lucide-react";
import { documentedTopics } from "@/lib/client/facts";
import { AiLabel, Spinner } from "@/components/ui";
import { TOPIC_LABELS, type ProjectDetail, type Topic } from "@/types/project";

const QUESTIONS: Record<Topic, string[]> = {
  air_quality: ["What air emissions do the records describe, and from what equipment?", "What mitigation is proposed for air quality impacts?"],
  greenhouse_gas: ["What do the records say about greenhouse gas emissions?"],
  energy: ["How much electricity or backup power capacity is proposed?", "How often would backup generators run for testing?"],
  water: ["How much water would the project use, and for what?", "What do the records say about stormwater or flooding?"],
  noise: ["What noise impacts are described, and when would they occur?"],
  traffic: ["How many vehicle or truck trips would the project generate?", "What do the records say about traffic and VMT?"],
  hazards: ["What hazardous materials would be stored on site?", "What do the records say about fuel storage and spill risk?"],
  land_use: ["How large is the project and what is on the site today?"],
  biological: ["Are any habitat, creek, or wildlife issues identified?"],
  community: ["Which schools or sensitive sites do the records mention near the project?", "How can residents participate in the review?"],
  economic: ["How many jobs do the records say the project would create?"],
  other: [],
};

interface Answer {
  answer: string;
  answerable: boolean;
  not_in_record: string | null;
  passages: { id: string; text: string; documentTitle: string; sourceUrl: string; page: number | null }[];
  cached?: boolean;
  error?: string;
}

export default function CommunityTab({ p }: { p: ProjectDetail }) {
  const topics = documentedTopics(p).filter((t) => QUESTIONS[t].length);
  const [open, setOpen] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer | "loading">>({});
  const [custom, setCustom] = useState("");

  async function ask(q: string) {
    setOpen(q);
    if (answers[q] && answers[q] !== "loading" && !(answers[q] as Answer).error) return;
    setAnswers((a) => ({ ...a, [q]: "loading" }));
    try {
      const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: p.id, question: q }) });
      const data = await res.json();
      setAnswers((a) => ({ ...a, [q]: res.ok ? data : { error: data.error ?? "Something went wrong", answer: "", answerable: false, not_in_record: null, passages: [] } }));
    } catch {
      setAnswers((a) => ({ ...a, [q]: { error: "Network error", answer: "", answerable: false, not_in_record: null, passages: [] } }));
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl bg-paper p-3 text-[13px] leading-snug text-ink-2">
        <p className="flex items-center gap-1.5 font-medium text-ink">
          <MessageSquareText className="size-4" /> Questions residents often raise
        </p>
        <p className="mt-1">
          Starter questions for the topics these records actually discuss. Answers are AI explanations drawn only from retrieved source passages, with citations. This is not a forum,
          and nothing here comes from real community members.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (custom.trim().length >= 8) ask(custom.trim());
        }}
        className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 focus-within:border-ink-3"
      >
        <Search className="size-4 shrink-0 text-ink-3" />
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          maxLength={300}
          placeholder="Ask the records a question…"
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3"
          aria-label="Ask a question about this project's records"
        />
        <button disabled={custom.trim().length < 8} className="rounded-lg bg-ink px-3 py-1 text-[12px] font-medium text-white disabled:opacity-30">
          Ask
        </button>
      </form>
      {custom && answers[custom.trim()] && open === custom.trim() && <AnswerView a={answers[custom.trim()]} />}

      {topics.map((t) => (
        <section key={t}>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">{TOPIC_LABELS[t]}</h3>
          <ul className="space-y-1.5">
            {QUESTIONS[t].map((q) => {
              const isOpen = open === q;
              return (
                <li key={q} className={`rounded-xl border transition ${isOpen ? "border-line-2 bg-panel shadow-sm" : "border-line"}`}>
                  <button onClick={() => (isOpen ? setOpen(null) : ask(q))} aria-expanded={isOpen} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[14px]">
                    <HelpCircle className="size-4 shrink-0 text-ink-3" />
                    <span className="flex-1">{q}</span>
                    <ChevronDown className={`size-4 text-ink-3 transition ${isOpen ? "rotate-180" : ""}`} />
                  </button>
                  {isOpen && answers[q] && (
                    <div className="px-3 pb-3">
                      <AnswerView a={answers[q]} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {topics.length === 0 && <p className="text-[13px] text-ink-3">No topics with enough source material yet.</p>}
    </div>
  );
}

function AnswerView({ a }: { a: Answer | "loading" }) {
  if (a === "loading")
    return (
      <div className="flex items-center gap-2 rounded-lg bg-ai/[0.05] px-3 py-3 text-[13px] text-ai">
        <Spinner className="size-3.5" /> Searching retrieved records and drafting an answer…
      </div>
    );
  if (a.error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-800">{a.error}</p>;
  return (
    <div className="animate-rise space-y-3 rounded-lg border border-ai/15 bg-ai/[0.03] p-3">
      <AiLabel>{a.answerable ? "AI explanation · grounded in cited passages" : "Not answered by the record"}</AiLabel>
      <p className="text-[14px] leading-relaxed">{a.answer}</p>
      {a.passages.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Source passages</p>
          {a.passages.map((p) => (
            <figure key={p.id} className="rounded-lg border border-line bg-panel p-2.5">
              <blockquote className="quote line-clamp-6 text-[13px] leading-relaxed text-ink-2">“{p.text}”</blockquote>
              <figcaption className="mt-1.5">
                <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium hover:underline">
                  [{p.id}] {p.documentTitle}
                  {p.page ? `, p. ${p.page}` : ""} <ExternalLink className="size-3" />
                </a>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {a.not_in_record && (
        <p className="rounded-lg bg-[#f6efe2] px-3 py-2 text-[13px] text-[#5e4a22]">
          <span className="font-semibold">Open question for the agency:</span> {a.not_in_record}
        </p>
      )}
    </div>
  );
}
