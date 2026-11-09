"use client";

import { AlertTriangle, CheckCircle2, Clapperboard, FilePlus2, FolderOpen, FolderPlus, HardDrive, Loader2, RefreshCw, SkipForward, X, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "@/components/editor/store";
import FolderPicker, { FolderField } from "@/components/merge/FolderPicker";
import { FileQueueList, useFileQueue } from "./FileQueue";
import { fmtDur, fmtEta, fmtSize } from "./format";
import { CONVERT_QUALITIES, type ConvertEvent, type ConvertFile, type ConvertOptions, type ConvertPlan, type ConvertQuality, type ConvertRequest } from "@/lib/convert";

const STORAGE_KEY = "lve-convert-v1";

type RowState = { state: "running" | "done" | "skipped" | "failed"; percent?: number; message?: string; size?: number };
type Phase = "idle" | "planning" | "ready" | "running" | "done";
type Planned = ConvertPlan & { options: ConvertOptions };

/** Whole folders, checked first and then converted together; or single files, each converted as soon as it's added. */
type Mode = "folders" | "files";

function loadSaved(): Partial<ConvertOptions> & { mode?: Mode; fileDir?: string } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") ?? {};
  } catch {
    return {};
  }
}

const isDrive = (p: string) => p.startsWith("/Volumes/") || /^[A-Z]:\\/.test(p);

export default function ConvertTool() {
  const [saved] = useState(loadSaved);
  const [sources, setSources] = useState<string[]>(Array.isArray(saved.sources) ? saved.sources : []);
  const [out, setOut] = useState(saved.out ?? "");
  const [quality, setQuality] = useState<ConvertQuality>(CONVERT_QUALITIES.includes(saved.quality!) ? saved.quality! : "1080");
  const [copyFit, setCopyFit] = useState(saved.copyFit !== false);
  const [mode, setMode] = useState<Mode>(saved.mode === "files" ? "files" : "folders");
  const [fileDir, setFileDir] = useState(saved.fileDir ?? "");
  const [picker, setPicker] = useState<"add" | "out" | "file" | null>(null);
  const queue = useFileQueue();

  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<Planned | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [overall, setOverall] = useState(0);
  const [speeds, setSpeeds] = useState<Record<string, number>>({});
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [engine, setEngine] = useState<{ encoder: string | null; parallel: number } | null>(null);
  const [summary, setSummary] = useState<Extract<ConvertEvent, { type: "done" }> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Remember the folders and settings between visits.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sources, out, quality, copyFit, mode, fileDir }));
    } catch {}
  }, [sources, out, quality, copyFit, mode, fileDir]);

  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const runPlan = async (options: ConvertOptions) => {
    if (!options.sources.length || !options.out) {
      setPlan(null);
      return;
    }
    setPhase("planning");
    setError(null);
    setSummary(null);
    setRows({});
    try {
      const res = await fetch("/api/convert/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Серверийн алдаа (${res.status})`);
      const p: Planned = { ...(data as ConvertPlan), options };
      // Re-checking (quality changed, folder added) keeps what the user unticked.
      const prev = plan ? new Map(plan.files.map((f) => [f.key, f])) : null;
      const open = (f: ConvertFile | undefined) => !!f && !f.problem && !f.exists;
      setPlan(p);
      setChosen(new Set(p.files.filter((f) => open(f) && (open(prev?.get(f.key)) ? chosen.has(f.key) : true)).map((f) => f.key)));
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  const options: ConvertOptions = { sources, files: [], out, quality, copyFit };
  const replan = (patch: Partial<ConvertOptions>) => {
    if (mode === "folders" && (plan || patch.sources || patch.out)) runPlan({ ...options, ...patch });
  };
  const queued = useMemo(
    () => new Set(queue.items.filter((it) => it.out === out && it.state !== "failed" && it.state !== "cancelled").map((it) => it.path)),
    [queue.items, out],
  );

  const files = useMemo(() => plan?.files ?? [], [plan]);
  const byFolder = useMemo(() => {
    const m = new Map<string, ConvertFile[]>();
    for (const f of files) m.set(f.folder, [...(m.get(f.folder) ?? []), f]);
    return [...m];
  }, [files]);

  const selected = files.filter((f) => chosen.has(f.key));
  const selectedDuration = selected.reduce((s, f) => s + (f.duration ?? 0), 0);
  const selectedSize = selected.reduce((s, f) => s + f.size, 0);
  const copies = selected.filter((f) => f.action === "copy").length;
  const problems = files.filter((f) => f.problem).length;
  const existing = files.filter((f) => f.exists).length;

  const toggle = (keys: string[], on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const start = async () => {
    if (!plan || !selected.length) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    setRows({});
    setOverall(0);
    setSpeeds({});
    setSummary(null);
    setEngine(null);
    setError(null);
    setStartedAt(Date.now());
    setNow(Date.now());

    const body: ConvertRequest = { ...plan.options, items: selected.map((f) => f.key) };
    try {
      const res = await fetch("/api/convert", {
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
          const event = JSON.parse(line) as ConvertEvent;
          if (event.type === "start") {
            setEngine({ encoder: event.encoder, parallel: event.parallel });
          } else if (event.type === "item") {
            // Finished files drop out of the selection so pressing the button again doesn't redo them.
            if (event.state === "done" || event.state === "skipped") toggle([event.key], false);
            if (event.state !== "running")
              setSpeeds((s) => {
                const next = { ...s };
                delete next[event.key];
                return next;
              });
            setRows((r) => ({
              ...r,
              [event.key]:
                event.state === "running"
                  ? { state: "running", percent: 0 }
                  : event.state === "done"
                    ? { state: "done", percent: 100, size: event.size }
                    : { state: event.state, message: event.message },
            }));
          } else if (event.type === "progress") {
            setRows((r) => ({ ...r, [event.key]: { state: "running", percent: event.percent } }));
            if (event.speed) setSpeeds((s) => ({ ...s, [event.key]: event.speed! }));
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
      setSpeeds({});
    }
  };

  const running = phase === "running";
  const busy = running || phase === "planning";
  const elapsed = running ? now - startedAt : 0;
  const eta = running && overall > 1 ? (elapsed * (100 - overall)) / overall : null;
  const speed = Object.values(speeds).reduce((s, v) => s + v, 0);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-32 sm:px-6 lg:py-10">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 shadow-lg shadow-violet-900/40">
            <Clapperboard className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white sm:text-2xl">Олноор хөрвүүлэх</h1>
            <p className="text-sm text-zinc-400">Кинонуудыг нэрийг нь хадгалан 1080p / 720p MP4 болгоно — хавтсаар эсвэл нэг нэгээр</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/" className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-violet-500 hover:text-white">
            ← Timeline засварлагч
          </Link>
          <Link href="/merge" className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-violet-500 hover:text-white">
            Хэсэг нийлүүлэх
          </Link>
        </div>
      </header>

      <section className="mb-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-5">
        <div className="mb-4 inline-flex rounded-xl border border-zinc-800 bg-zinc-950 p-1">
          {(
            [
              ["folders", "Хавтсаар", "Шалгаад бүгдийг нь"],
              ["files", "Нэг нэгээр", "Нэмэнгүүт шууд"],
            ] as const
          ).map(([m, title, note]) => (
            <button
              key={m}
              type="button"
              disabled={busy}
              onClick={() => setMode(m)}
              className={cx("rounded-lg px-4 py-1.5 text-left transition disabled:opacity-50", mode === m ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-white")}
            >
              <div className="text-sm font-semibold">{title}</div>
              <div className={cx("text-[11px]", mode === m ? "text-violet-200" : "text-zinc-600")}>{note}</div>
            </button>
          ))}
        </div>
        {mode === "files" ? (
          <div className="grid gap-4 md:grid-cols-2">
            <FolderField label="1. Гаралтын хавтас" hint="Хөрвүүлсэн файл шууд энд, ижил нэрээрээ бичигдэнэ" value={out} disabled={false} onBrowse={() => setPicker("out")} />
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">2. Кино нэмэх</div>
              <button
                type="button"
                disabled={!out}
                onClick={() => setPicker("file")}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-3 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 transition hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:shadow-none"
              >
                <FilePlus2 className="h-5 w-5" /> Файл сонгох
              </button>
              <p className="mt-1.5 text-xs text-zinc-600">{out ? "Сонгосон файл бүр шууд хөрвүүлэгдэж эхэлнэ" : "Эхлээд гаралтын хавтсаа сонгоно уу"}</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">1. Хавтсууд (нэг эсвэл хэд хэдэн)</div>
              <div className="space-y-1.5">
                {sources.map((s) => (
                  <div key={s} className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
                    {isDrive(s) ? <HardDrive className="h-4 w-4 shrink-0 text-amber-400" /> : <FolderOpen className="h-4 w-4 shrink-0 text-violet-400" />}
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-100" title={s}>
                      {s}
                    </span>
                    <button
                      type="button"
                      title="Хасах"
                      disabled={busy}
                      onClick={() => {
                        const next = sources.filter((x) => x !== s);
                        setSources(next);
                        replan({ sources: next });
                      }}
                      className="rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-white disabled:opacity-40"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPicker("add")}
                  className="flex w-full items-center gap-2 rounded-xl border border-dashed border-zinc-700 px-3 py-2.5 text-sm text-zinc-300 transition hover:border-violet-500 hover:text-white disabled:opacity-50"
                >
                  <FolderPlus className="h-4 w-4 text-violet-400" /> Хавтас нэмэх
                </button>
              </div>
              <p className="mt-1.5 text-xs text-zinc-600">Дэд хавтсуудыг бүгдийг нь уншина</p>
            </div>
            <FolderField label="2. Гаралтын хавтас" hint="Хавтас бүр нэрээрээ энд үүснэ" value={out} disabled={busy} onBrowse={() => setPicker("out")} />
          </div>
        )}

        <div className="mt-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">3. Хэмжээ</div>
          <div className="flex flex-wrap gap-2">
            {CONVERT_QUALITIES.map((q) => (
              <button
                key={q}
                type="button"
                disabled={busy}
                onClick={() => {
                  if (q === quality) return;
                  setQuality(q);
                  replan({ quality: q });
                }}
                className={cx(
                  "rounded-xl border px-5 py-2 text-left transition disabled:opacity-50",
                  q === quality ? "border-violet-500 bg-violet-500/15 text-white" : "border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-600",
                )}
              >
                <div className="text-sm font-semibold">{q}p</div>
                <div className="text-[11px] text-zinc-500">{q === "1080" ? "1920×1080" : "1280×720"} MP4</div>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-zinc-600">
            H.264 өндөр чанар (CRF 20) — нүдэнд эхтэйгээ ялгаагүй. Жижиг видеог томруулахгүй. Mac-ийн видео чипээр 3 киног зэрэг хийнэ. AAC дууг шууд хуулна.
            {mode === "files" && " Тохиргоог өөрчилбөл дараа нэмэх файлуудад үйлчилнэ."}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className={cx("flex cursor-pointer items-center gap-2 text-sm text-zinc-300", busy && "pointer-events-none opacity-50")}>
            <input
              type="checkbox"
              checked={copyFit}
              onChange={(e) => {
                setCopyFit(e.target.checked);
                replan({ copyFit: e.target.checked });
              }}
              className="h-4 w-4 accent-violet-500"
            />
            Аль хэдийн H.264, {quality}p-ээс бага бол encode-гүй хуулах <span className="text-zinc-500">(хамгийн хурдан, чанар 100%)</span>
          </label>
          {mode === "folders" && (
            <button
              type="button"
              disabled={!sources.length || !out || busy}
              onClick={() => runPlan(options)}
              className="flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-violet-500 hover:text-white disabled:opacity-40"
            >
              {phase === "planning" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {phase === "planning" ? "Файлуудыг шалгаж байна…" : plan ? "Дахин шалгах" : "Шалгах"}
            </button>
          )}
        </div>
      </section>

      {mode === "files" && <FileQueueList queue={queue} />}

      {mode === "folders" && error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {mode === "folders" && summary && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          <CheckCircle2 className="h-5 w-5" />
          <span className="font-semibold">Дууслаа: {summary.made} файл бэлэн</span>
          {summary.skipped > 0 && <span>{summary.skipped} алгассан</span>}
          {summary.failed > 0 && <span className="text-red-300">{summary.failed} алдаатай</span>}
          <span className="text-emerald-300/70">{fmtEta(summary.elapsedMs)}</span>
          <span className="w-full truncate font-mono text-xs text-emerald-300/70">{plan?.out}</span>
        </div>
      )}

      {mode === "folders" && plan && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-zinc-400">
              <span className="text-zinc-200">{files.length}</span> видео олдлоо
              {existing > 0 && <span> · {existing} нь аль хэдийн хөрвүүлэгдсэн</span>}
              {problems > 0 && <span className="text-amber-400"> · {problems} асуудалтай</span>}
            </p>
            {!running && files.length > 0 && (
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setChosen(new Set(files.filter((f) => !f.problem && !f.exists).map((f) => f.key)))}
                  className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                >
                  Бүгдийг сонгох
                </button>
                <button type="button" onClick={() => setChosen(new Set())} className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
                  Бүгдийг болих
                </button>
              </div>
            )}
          </div>

          {!files.length && <p className="rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-500">Сонгосон хавтсуудад видео файл олдсонгүй.</p>}

          <div className="space-y-4">
            {byFolder.map(([folder, list]) => {
              const open = list.filter((f) => !f.problem && !f.exists);
              const all = open.length > 0 && open.every((f) => chosen.has(f.key));
              return (
                <section key={folder} className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40">
                  <label className="flex cursor-pointer items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-400">
                    <input
                      type="checkbox"
                      checked={all}
                      disabled={running || !open.length}
                      onChange={(e) => toggle(open.map((f) => f.key), e.target.checked)}
                      className="h-3.5 w-3.5 accent-violet-500"
                    />
                    <FolderOpen className="h-3.5 w-3.5 text-violet-400" />
                    <span className="truncate font-mono">{folder}</span>
                    <span className="ml-auto shrink-0">{list.length}</span>
                  </label>
                  <div className="divide-y divide-zinc-800/70">
                    {list.map((f) => (
                      <FileRow key={f.key} file={f} checked={chosen.has(f.key)} row={rows[f.key]} locked={running} onCheck={(on) => toggle([f.key], on)} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}

      {mode === "folders" && plan && files.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-[#0b0b0f]/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
            {running ? (
              <>
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex justify-between gap-3 font-mono text-xs text-zinc-400">
                    <span>{overall.toFixed(1)}%</span>
                    <span className="truncate">
                      {engine?.encoder && `${engine.encoder} · ${engine.parallel} зэрэг · `}
                      {speed > 0 && `${speed.toFixed(1)}× хурд · `}
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
                  <span className="text-white">{selected.length}</span> файл · {fmtDur(selectedDuration)} · {fmtSize(selectedSize)}
                  {copies > 0 && <span className="text-zinc-500"> ({copies} нь encode-гүй)</span>} →{" "}
                  <span className="font-mono text-xs text-zinc-500">{plan.out}</span>
                </p>
                <button
                  type="button"
                  disabled={!selected.length || phase === "planning"}
                  onClick={start}
                  className="flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 transition hover:bg-violet-500 disabled:opacity-40"
                >
                  <Clapperboard className="h-4 w-4" /> {plan.options.quality}p болгох ({selected.length})
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {picker === "file" && (
        <FolderPicker
          title="Хөрвүүлэх кино сонгох"
          initial={fileDir || sources[0] || ""}
          picked={queued}
          onClose={() => setPicker(null)}
          onPickFile={(f) => {
            setFileDir(f.path.slice(0, Math.max(f.path.lastIndexOf("/"), f.path.lastIndexOf("\\")) + 1) || f.path);
            queue.add(f, { out, quality, copyFit });
          }}
        />
      )}

      {(picker === "add" || picker === "out") && (
        <FolderPicker
          title={picker === "add" ? "Хөрвүүлэх хавтас нэмэх" : "Гаралтын хавтас сонгох"}
          initial={picker === "add" ? sources[sources.length - 1] ?? "" : out || sources[0] || ""}
          allowCreate={picker === "out"}
          onClose={() => setPicker(null)}
          onPick={(p) => {
            setPicker(null);
            if (picker === "add") {
              if (sources.includes(p)) return;
              const next = [...sources, p];
              setSources(next);
              replan({ sources: next });
            } else {
              setOut(p);
              replan({ out: p });
            }
          }}
        />
      )}
    </main>
  );
}

function FileRow({ file: f, checked, row, locked, onCheck }: { file: ConvertFile; checked: boolean; row: RowState | undefined; locked: boolean; onCheck: (on: boolean) => void }) {
  const disabled = !!f.problem || f.exists || locked;
  const name = f.key.split("/").pop()!;
  return (
    <div className={cx("relative flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5", !checked && !row && "opacity-55")}>
      {row?.state === "running" && <div className="absolute inset-y-0 left-0 bg-violet-500/10 transition-[width] duration-500" style={{ width: `${row.percent ?? 0}%` }} />}
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onCheck(e.target.checked)} className="relative h-4 w-4 shrink-0 accent-violet-500" />
      <div className="relative min-w-[220px] flex-1 truncate font-mono text-sm text-zinc-100" title={`${f.source} → ${name}`}>
        {name}
        {f.source !== name && <span className="ml-2 text-xs text-zinc-600">{f.source}</span>}
      </div>
      <span className="relative w-48 shrink-0 text-xs text-zinc-400">
        {f.width && f.height ? (
          <>
            {f.width}×{f.height} <span className="text-zinc-600">{f.videoCodec}</span>
            {f.action === "copy" ? <span className="text-emerald-400"> · хуулна</span> : f.outSize && (f.outSize[0] !== f.width || f.outSize[1] !== f.height) ? <span className="text-violet-300"> → {f.outSize[0]}×{f.outSize[1]}</span> : null}
          </>
        ) : (
          "—"
        )}
      </span>
      <span className="relative w-16 shrink-0 text-right font-mono text-xs text-zinc-400">{f.duration ? fmtDur(f.duration) : "—"}</span>
      <span className="relative w-24 shrink-0 text-right font-mono text-xs text-zinc-500">
        {row?.size ? (
          <>
            → <span className="text-emerald-400">{fmtSize(row.size)}</span>
          </>
        ) : (
          fmtSize(f.size)
        )}
      </span>
      <span className="relative flex w-40 shrink-0 justify-end text-xs">
        <Status file={f} row={row} />
      </span>
    </div>
  );
}

function Status({ file, row }: { file: ConvertFile; row: RowState | undefined }) {
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
      <span className="flex min-w-0 items-center gap-1.5 text-red-400" title={row.message}>
        <XCircle className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">Алдаа: {row.message}</span>
      </span>
    );
  if (file.problem)
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-amber-400" title={file.problem}>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{file.problem}</span>
      </span>
    );
  if (file.exists)
    return (
      <span className="inline-flex items-center gap-1.5 text-zinc-500">
        <X className="h-3.5 w-3.5" /> Аль хэдийн бий
      </span>
    );
  return <span className="text-zinc-600">Хүлээгдэж байна</span>;
}
