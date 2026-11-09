"use client";

import { AlertTriangle, CheckCircle2, Combine, FolderOpen, Loader2, RefreshCw, SkipForward, X, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "@/components/editor/store";
import FolderPicker, { FolderField } from "./FolderPicker";
import { MERGE_QUALITIES, MIXED_PROBLEM, outputExt, outputRelPath, type MergeEvent, type MergeGroup, type MergePlan, type MergeQuality, type MergeRequest } from "@/lib/merge";

const STORAGE_KEY = "lve-merge-v1";

type RowState = { state: "running" | "done" | "skipped" | "failed"; percent?: number; message?: string };
type Phase = "idle" | "planning" | "ready" | "running" | "done";
type Planned = MergePlan & { quality: MergeQuality };

const QUALITY_LABEL: Record<MergeQuality, { title: string; note: string }> = {
  copy: { title: "Анхны чанар", note: "encode-гүй" },
  "1080": { title: "1080p", note: "encode" },
  "720": { title: "720p", note: "encode" },
  "480": { title: "480p", note: "encode" },
};

/** Why a group can't be ticked with this quality, or null. */
function blocker(g: MergeGroup, quality: MergeQuality) {
  return g.problem ?? (g.mixed && quality === "copy" ? MIXED_PROBLEM : null);
}

function fmtDur(sec: number) {
  const s = Math.round(sec);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmtSize(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function fmtEta(ms: number) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} сек` : `${s} сек`;
}

function loadSaved(): { source?: string; out?: string; flat?: boolean; quality?: MergeQuality } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") ?? {};
  } catch {
    return {};
  }
}

export default function MergeTool() {
  const [saved] = useState(loadSaved);
  const [source, setSource] = useState(saved.source ?? "");
  const [out, setOut] = useState(saved.out ?? "");
  const [flat, setFlat] = useState(saved.flat === true);
  const [quality, setQuality] = useState<MergeQuality>(MERGE_QUALITIES.includes(saved.quality!) ? saved.quality! : "copy");
  const [picker, setPicker] = useState<"source" | "out" | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<Planned | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});

  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [overall, setOverall] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [encoder, setEncoder] = useState<string | null>(null);
  const [summary, setSummary] = useState<Extract<MergeEvent, { type: "done" }> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Remember the folders between visits.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ source, out, flat, quality }));
    } catch {}
  }, [source, out, flat, quality]);

  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const runPlan = async (src = source, dst = out, isFlat = flat, q = quality) => {
    if (!src || !dst) return;
    setPhase("planning");
    setError(null);
    setSummary(null);
    setRows({});
    try {
      const res = await fetch("/api/merge/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: src, out: dst, flat: isFlat, quality: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Серверийн алдаа (${res.status})`);
      const p: Planned = { ...(data as MergePlan), quality: q };
      // Re-checking the same source (layout or quality changed) keeps the user's ticks and names.
      const prev = plan?.source === p.source ? new Map(plan.groups.map((g) => [g.key, g])) : null;
      const wasOpen = (g: MergeGroup | undefined) => !!g && !g.exists && !blocker(g, plan!.quality);
      setPlan(p);
      setChosen(
        new Set(
          p.groups
            .filter((g) => !blocker(g, q) && !g.exists && (wasOpen(prev?.get(g.key)) ? chosen.has(g.key) : true))
            .map((g) => g.key),
        ),
      );
      setNames(Object.fromEntries(p.groups.map((g) => [g.key, (prev?.has(g.key) && names[g.key]) || g.base])));
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  const groups = useMemo(() => plan?.groups ?? [], [plan]);
  const byFolder = useMemo(() => {
    const m = new Map<string, MergeGroup[]>();
    for (const g of groups) m.set(g.relDir, [...(m.get(g.relDir) ?? []), g]);
    return [...m];
  }, [groups]);

  const selected = groups.filter((g) => chosen.has(g.key));
  const selectedSize = selected.reduce((s, g) => s + g.size, 0);
  const problems = groups.filter((g) => blocker(g, quality)).length;
  const selectedDuration = selected.reduce((s, g) => s + g.duration, 0);

  // Two chosen groups that would write the same file.
  const clashes = useMemo(() => {
    const seen = new Map<string, number>();
    for (const g of selected) {
      const rel = outputRelPath(g, names[g.key] || g.base, flat, quality).toLowerCase();
      seen.set(rel, (seen.get(rel) ?? 0) + 1);
    }
    return new Set(selected.filter((g) => (seen.get(outputRelPath(g, names[g.key] || g.base, flat, quality).toLowerCase()) ?? 0) > 1).map((g) => g.key));
  }, [selected, names, flat, quality]);

  const toggle = (key: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const start = async () => {
    if (!plan || !selected.length || clashes.size) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    setRows({});
    setOverall(0);
    setSummary(null);
    setEncoder(null);
    setError(null);
    setStartedAt(Date.now());
    setNow(Date.now());

    const body: MergeRequest = {
      source: plan.source,
      out: plan.out,
      flat,
      quality: plan.quality,
      items: selected.map((g) => ({ key: g.key, name: names[g.key] || g.base })),
    };
    try {
      const res = await fetch("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Серверийн алдаа (${res.status})`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const event = JSON.parse(line) as MergeEvent;
          if (event.type === "start") {
            setEncoder(event.encoder);
          } else if (event.type === "item") {
            // Finished files drop out of the selection so pressing the button again doesn't redo them.
            if (event.state === "done" || event.state === "skipped") toggle(event.key, false);
            setRows((r) => ({ ...r, [event.key]: event.state === "done" || event.state === "running" ? { state: event.state, percent: event.state === "done" ? 100 : 0 } : { state: event.state, message: event.message } }));
          } else if (event.type === "progress") {
            setRows((r) => ({ ...r, [event.key]: { state: "running", percent: event.percent } }));
            setOverall(event.overall);
          } else if (event.type === "done") {
            finished = true;
            setSummary(event);
            setOverall(100);
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      }
      if (!finished) throw new Error("Сервертэй холболт тасарлаа.");
      setPhase("done");
    } catch (err) {
      setPhase("ready");
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      else setError("Цуцлагдлаа. Дуусаагүй байсан файлыг устгасан, эх файлууд хэвээрээ.");
      setRows((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v.state !== "running")));
    } finally {
      abortRef.current = null;
    }
  };

  const running = phase === "running";
  const elapsed = running ? now - startedAt : 0;
  const eta = running && overall > 1 ? (elapsed * (100 - overall)) / overall : null;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-32 sm:px-6 lg:py-10">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 shadow-lg shadow-violet-900/40">
            <Combine className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white sm:text-2xl">Хэсэг нийлүүлэх</h1>
            <p className="text-sm text-zinc-400">
              <span className="font-mono text-zinc-300">KINO_X_1, _2, _3</span> → <span className="font-mono text-zinc-300">KINO_X</span> · хүсвэл 720p гэх мэтээр encode хийнэ
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/" className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-violet-500 hover:text-white">
            ← Timeline засварлагч
          </Link>
          <Link href="/compress" className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-violet-500 hover:text-white">
            Хурдан шахах
          </Link>
          <Link href="/convert" className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-violet-500 hover:text-white">
            Олноор хөрвүүлэх
          </Link>
        </div>
      </header>

      <section className="mb-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <FolderField
            label="1. Эх хавтас эсвэл диск"
            hint="Дэд хавтсуудыг бүгдийг нь уншина"
            value={source}
            disabled={running}
            onBrowse={() => setPicker("source")}
          />
          <FolderField label="2. Гаралтын хавтас" hint="Жишээ нь дискийн final хавтас" value={out} disabled={running} onBrowse={() => setPicker("out")} />
        </div>
        <div className="mt-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">3. Чанар</div>
          <div className="flex flex-wrap gap-2">
            {MERGE_QUALITIES.map((q) => (
              <button
                key={q}
                type="button"
                disabled={running || phase === "planning"}
                onClick={() => {
                  if (q === quality) return;
                  setQuality(q);
                  if (plan) runPlan(source, out, flat, q);
                }}
                className={cx(
                  "rounded-xl border px-4 py-2 text-left transition disabled:opacity-50",
                  q === quality ? "border-violet-500 bg-violet-500/15 text-white" : "border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-600",
                )}
              >
                <div className="text-sm font-semibold">{QUALITY_LABEL[q].title}</div>
                <div className="text-[11px] text-zinc-500">{QUALITY_LABEL[q].note}</div>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-zinc-600">
            {quality === "copy"
              ? "Хэсгүүдийг шууд залгана: чанар алдагдахгүй, кино тутам хэдхэн секунд."
              : `${QUALITY_LABEL[quality].title} H.264 MP4 болгож шахна: файл жижгэрнэ, гэхдээ кино тутамд хэдэн минут болно. Формат зөрүүтэй хэсгүүдийг ч нийлүүлнэ. Жижиг видеог томруулахгүй.`}
          </p>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className={cx("flex cursor-pointer items-center gap-2 text-sm text-zinc-300", running && "pointer-events-none opacity-50")}>
            <input
              type="checkbox"
              checked={!flat}
              onChange={(e) => {
                setFlat(!e.target.checked);
                if (plan) runPlan(source, out, !e.target.checked);
              }}
              className="h-4 w-4 accent-violet-500"
            />
            Хавтасны бүтцийг хадгалах <span className="text-zinc-500">(serial/…, usk/…)</span>
          </label>
          <button
            type="button"
            disabled={!source || !out || running || phase === "planning"}
            onClick={() => runPlan()}
            className="flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-violet-500 hover:text-white disabled:opacity-40"
          >
            {phase === "planning" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {phase === "planning" ? "Файлуудыг шалгаж байна…" : plan ? "Дахин шалгах" : "Шалгах"}
          </button>
        </div>
      </section>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {summary && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          <CheckCircle2 className="h-5 w-5" />
          <span className="font-semibold">Дууслаа: {summary.made} файл үүслээ</span>
          {summary.skipped > 0 && <span>{summary.skipped} алгассан</span>}
          {summary.failed > 0 && <span className="text-red-300">{summary.failed} алдаатай</span>}
          <span className="text-emerald-300/70">{fmtEta(summary.elapsedMs)}</span>
          <span className="w-full truncate font-mono text-xs text-emerald-300/70">{plan?.out}</span>
        </div>
      )}

      {plan && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-zinc-400">
              <span className="text-zinc-200">{groups.length}</span> бүлэг олдлоо
              {problems > 0 && <span className="text-amber-400"> · {problems} асуудалтай</span>}
              {plan.unmatched.length > 0 && <span> · {plan.unmatched.length} файл хэсгийн дугааргүй</span>}
            </p>
            {!running && groups.length > 0 && (
              <div className="flex gap-2 text-xs">
                <button type="button" onClick={() => setChosen(new Set(groups.filter((g) => !blocker(g, quality)).map((g) => g.key)))} className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
                  Бүгдийг сонгох
                </button>
                <button type="button" onClick={() => setChosen(new Set())} className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
                  Бүгдийг болих
                </button>
              </div>
            )}
          </div>

          {!groups.length && (
            <p className="rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-500">
              <span className="font-mono">НЭР_1, НЭР_2 …</span> хэлбэрийн нэртэй видео файл олдсонгүй.
            </p>
          )}

          <div className="space-y-4">
            {byFolder.map(([folder, list]) => (
              <section key={folder} className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40">
                <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-400">
                  <FolderOpen className="h-3.5 w-3.5 text-violet-400" />
                  <span className="truncate font-mono">{folder || "(эх хавтас)"}</span>
                  <span className="ml-auto shrink-0">{list.length}</span>
                </div>
                <div className="divide-y divide-zinc-800/70">
                  {list.map((g) => (
                    <GroupRow
                      key={g.key}
                      group={g}
                      problem={blocker(g, plan.quality)}
                      ext={outputExt(g, plan.quality)}
                      checked={chosen.has(g.key)}
                      name={names[g.key] ?? g.base}
                      clash={clashes.has(g.key)}
                      row={rows[g.key]}
                      locked={running}
                      onCheck={(on) => toggle(g.key, on)}
                      onName={(v) => setNames((n) => ({ ...n, [g.key]: v }))}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>

          {plan.unmatched.length > 0 && (
            <details className="mt-4 text-xs text-zinc-500">
              <summary className="cursor-pointer">Хэсгийн дугааргүй тул алгасах файлууд ({plan.unmatched.length})</summary>
              <ul className="mt-2 space-y-0.5 font-mono">
                {plan.unmatched.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {plan && groups.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-[#0b0b0f]/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
            {running ? (
              <>
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex justify-between font-mono text-xs text-zinc-400">
                    <span>{overall.toFixed(1)}%</span>
                    <span>
                      {encoder && `${encoder} · `}
                      {fmtEta(elapsed)}
                      {eta !== null && ` · үлдсэн ~${fmtEta(eta)}`}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                    <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width] duration-500" style={{ width: `${overall}%` }} />
                  </div>
                </div>
                <button type="button" onClick={() => abortRef.current?.abort()} className="rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-200 transition hover:border-red-500 hover:text-white">
                  Цуцлах
                </button>
              </>
            ) : (
              <>
                <p className="min-w-0 flex-1 text-sm text-zinc-400">
                  {clashes.size ? (
                    <span className="text-red-300">Улаанаар тэмдэглэсэн файлууд ижил нэртэй байна. Нэрийг нь өөрчилнө үү.</span>
                  ) : (
                    <>
                      <span className="text-white">{selected.length}</span> файл ·{" "}
                      {plan.quality === "copy" ? fmtSize(selectedSize) : `${fmtDur(selectedDuration)} · ${QUALITY_LABEL[plan.quality].title}`} →{" "}
                      <span className="font-mono text-xs text-zinc-500">{plan.out}</span>
                    </>
                  )}
                </p>
                <button
                  type="button"
                  disabled={!selected.length || clashes.size > 0}
                  onClick={start}
                  className="flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 transition hover:bg-violet-500 disabled:opacity-40"
                >
                  <Combine className="h-4 w-4" /> {plan.quality === "copy" ? "Нийлүүлэх" : `${QUALITY_LABEL[plan.quality].title} болгож нийлүүлэх`} ({selected.length})
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {picker && (
        <FolderPicker
          title={picker === "source" ? "Эх хавтас эсвэл диск сонгох" : "Гаралтын хавтас сонгох"}
          initial={picker === "source" ? source : out || source}
          allowCreate={picker === "out"}
          onClose={() => setPicker(null)}
          onPick={(p) => {
            const src = picker === "source" ? p : source;
            const dst = picker === "out" ? p : out;
            if (picker === "source") setSource(p);
            else setOut(p);
            setPicker(null);
            if (src && dst) runPlan(src, dst);
            else setPlan(null);
          }}
        />
      )}
    </main>
  );
}

function GroupRow({
  group: g,
  problem,
  ext,
  checked,
  name,
  clash,
  row,
  locked,
  onCheck,
  onName,
}: {
  group: MergeGroup;
  problem: string | null;
  ext: string;
  checked: boolean;
  name: string;
  clash: boolean;
  row: RowState | undefined;
  locked: boolean;
  onCheck: (on: boolean) => void;
  onName: (name: string) => void;
}) {
  const disabled = !!problem || locked;
  return (
    <div className={cx("relative flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5", !checked && !row && "opacity-55")}>
      {row?.state === "running" && <div className="absolute inset-y-0 left-0 bg-violet-500/10 transition-[width] duration-500" style={{ width: `${row.percent ?? 0}%` }} />}
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onCheck(e.target.checked)} className="relative h-4 w-4 shrink-0 accent-violet-500" />
      <div className="relative flex min-w-[220px] flex-1 items-center gap-1">
        <input
          value={name}
          disabled={disabled || !checked}
          onChange={(e) => onName(e.target.value)}
          spellCheck={false}
          className={cx(
            "min-w-0 flex-1 rounded-md border bg-transparent px-1.5 py-1 font-mono text-sm text-zinc-100 outline-none transition focus:border-violet-500 focus:bg-zinc-950",
            clash ? "border-red-500/70" : "border-transparent hover:border-zinc-700",
          )}
        />
        <span className="font-mono text-xs text-zinc-600">{ext}</span>
      </div>
      <span className="relative w-20 shrink-0 text-xs text-zinc-400" title={g.parts.map((p) => p.name).join("\n")}>
        {g.parts.length} хэсэг
      </span>
      <span className="relative w-16 shrink-0 text-right font-mono text-xs text-zinc-400">{fmtDur(g.duration)}</span>
      <span className="relative w-16 shrink-0 text-right font-mono text-xs text-zinc-500">{fmtSize(g.size)}</span>
      <span className="relative flex w-44 shrink-0 justify-end text-xs">
        <Status group={g} problem={problem} row={row} />
      </span>
    </div>
  );
}

function Status({ group, problem, row }: { group: MergeGroup; problem: string | null; row: RowState | undefined }) {
  if (row?.state === "running")
    return (
      <span className="inline-flex items-center gap-1.5 text-violet-300">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {Math.round(row.percent ?? 0)}%
      </span>
    );
  if (row?.state === "done")
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" /> Бэлэн
      </span>
    );
  if (row?.state === "skipped")
    return (
      <span className="inline-flex items-center gap-1.5 text-zinc-400" title={row.message}>
        <SkipForward className="h-3.5 w-3.5" /> Алгассан
      </span>
    );
  if (row?.state === "failed")
    return (
      <span className="inline-flex items-center gap-1.5 text-red-400" title={row.message}>
        <XCircle className="h-3.5 w-3.5" /> Алдаа
      </span>
    );
  if (problem)
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-amber-400" title={problem}>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{problem}</span>
      </span>
    );
  if (group.exists)
    return (
      <span className="inline-flex items-center gap-1.5 text-zinc-500">
        <X className="h-3.5 w-3.5" /> Аль хэдийн бий
      </span>
    );
  return <span className="text-zinc-600">Хүлээгдэж байна</span>;
}
