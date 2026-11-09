"use client";

import { AlertTriangle, CheckCircle2, FileVideo, Loader2, SkipForward, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "@/components/editor/store";
import { convertedName, type ConvertEvent, type ConvertQuality, type ConvertRequest } from "@/lib/convert";
import type { FsFile } from "@/lib/merge";
import { fmtSize } from "./format";

type State = "waiting" | "running" | "done" | "skipped" | "failed" | "cancelled";

export type QueueItem = {
  id: number;
  path: string;
  name: string;
  size: number;
  /** Settings as they were when the file was added; changing them later only affects new files. */
  out: string;
  quality: ConvertQuality;
  copyFit: boolean;
  state: State;
  percent: number;
  speed: number | null;
  message?: string;
  outPath?: string;
  outSize?: number;
};

const finished = (s: State) => s === "done" || s === "skipped" || s === "failed" || s === "cancelled";

/**
 * Films added one by one, each converted as soon as it's added: up to `limit` at once (three on the
 * Mac's video chip), the rest wait their turn. Every file is its own /api/convert request.
 */
export function useFileQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const itemsRef = useRef<QueueItem[]>([]);
  const aborts = useRef(new Map<number, AbortController>());
  const nextId = useRef(1);
  const limit = useRef(1);

  useEffect(() => {
    fetch("/api/capabilities")
      .then((r) => r.json())
      .then((c: { platform?: string; encoders?: { videotoolbox?: boolean } }) => {
        limit.current = c.platform === "darwin" && c.encoders?.videotoolbox ? 3 : 1;
      })
      .catch(() => {});
  }, []);

  const update = useCallback((id: number, patch: Partial<QueueItem>) => {
    itemsRef.current = itemsRef.current.map((it) => (it.id === id ? { ...it, ...patch } : it));
    setItems(itemsRef.current);
  }, []);

  const run = useCallback(
    async (item: QueueItem, pump: () => void) => {
      const controller = new AbortController();
      aborts.current.set(item.id, controller);
      update(item.id, { state: "running", percent: 0 });
      const body: ConvertRequest = { sources: [], files: [item.path], out: item.out, quality: item.quality, copyFit: item.copyFit, items: [convertedName(item.name)] };
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
        let ended = false;
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
            if (event.type === "progress") update(item.id, { percent: event.percent, speed: event.speed });
            else if (event.type === "item" && event.state === "done") update(item.id, { state: "done", percent: 100, outPath: event.path, outSize: event.size });
            else if (event.type === "item" && (event.state === "skipped" || event.state === "failed")) update(item.id, { state: event.state, message: event.message });
            else if (event.type === "error") throw new Error(event.message);
            else if (event.type === "done") ended = true;
          }
        }
        if (!ended) throw new Error("Сервертэй холболт тасарлаа.");
      } catch (err) {
        if (controller.signal.aborted) update(item.id, { state: "cancelled", message: "Цуцалсан" });
        else update(item.id, { state: "failed", message: err instanceof Error ? err.message : String(err) });
      } finally {
        aborts.current.delete(item.id);
        update(item.id, { speed: null });
        pump();
      }
    },
    [update],
  );

  const pump = useCallback(() => {
    let running = itemsRef.current.filter((it) => it.state === "running").length;
    for (const it of itemsRef.current) {
      if (running >= limit.current) break;
      if (it.state !== "waiting") continue;
      running++;
      run(it, pump);
    }
  }, [run]);

  /** Adds a file and starts it right away when a slot is free. */
  const add = useCallback(
    (file: FsFile, settings: Pick<QueueItem, "out" | "quality" | "copyFit">) => {
      const live = itemsRef.current.filter((it) => it.state !== "failed" && it.state !== "cancelled");
      if (live.some((it) => it.path === file.path && it.out === settings.out)) return;
      const outName = convertedName(file.name).toLowerCase();
      const twin = live.find((it) => it.out === settings.out && convertedName(it.name).toLowerCase() === outName);
      const item: QueueItem = {
        id: nextId.current++,
        path: file.path,
        name: file.name,
        size: file.size,
        ...settings,
        state: twin ? "failed" : "waiting",
        percent: 0,
        speed: null,
        message: twin ? `Ижил нэртэй файл аль хэдийн нэмэгдсэн: ${twin.path}` : undefined,
      };
      itemsRef.current = [...itemsRef.current, item];
      setItems(itemsRef.current);
      pump();
    },
    [pump],
  );

  const cancel = useCallback(
    (id: number) => {
      const it = itemsRef.current.find((x) => x.id === id);
      if (it?.state === "running") aborts.current.get(id)?.abort();
      else if (it?.state === "waiting") update(id, { state: "cancelled", message: "Цуцалсан" });
    },
    [update],
  );

  const cancelAll = useCallback(() => {
    for (const it of itemsRef.current) if (!finished(it.state)) cancel(it.id);
  }, [cancel]);

  const clearFinished = useCallback(() => {
    itemsRef.current = itemsRef.current.filter((it) => !finished(it.state));
    setItems(itemsRef.current);
  }, []);

  /** Puts a failed or cancelled file back in line. */
  const retry = useCallback(
    (id: number) => {
      update(id, { state: "waiting", percent: 0, message: undefined });
      pump();
    },
    [update, pump],
  );

  // Closing the tab would kill the conversions in progress.
  const busy = items.some((it) => !finished(it.state));
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  return { items, add, cancel, cancelAll, clearFinished, retry, busy };
}

export function FileQueueList({ queue }: { queue: ReturnType<typeof useFileQueue> }) {
  const { items, cancel, cancelAll, clearFinished, retry, busy } = queue;
  if (!items.length) return null;
  const count = (s: State) => items.filter((it) => it.state === s).length;
  const speed = items.reduce((s, it) => s + (it.speed ?? 0), 0);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-zinc-400">
          <span className="text-emerald-400">{count("done")} бэлэн</span>
          {count("running") > 0 && <span className="text-violet-300"> · {count("running")} хөрвүүлж байна</span>}
          {count("waiting") > 0 && <span> · {count("waiting")} хүлээгдэж байна</span>}
          {count("failed") > 0 && <span className="text-red-400"> · {count("failed")} алдаатай</span>}
          {speed > 0 && <span className="font-mono text-xs text-zinc-500"> · {speed.toFixed(1)}× хурд</span>}
        </p>
        <div className="flex gap-2 text-xs">
          {busy && (
            <button type="button" onClick={cancelAll} className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-red-300">
              Бүгдийг цуцлах
            </button>
          )}
          {items.some((it) => finished(it.state)) && (
            <button type="button" onClick={clearFinished} className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
              Дууссаныг цэвэрлэх
            </button>
          )}
        </div>
      </div>
      <div className="divide-y divide-zinc-800/70 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40">
        {items.map((it) => (
          <div key={it.id} className="relative flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
            {it.state === "running" && <div className="absolute inset-y-0 left-0 bg-violet-500/10 transition-[width] duration-500" style={{ width: `${it.percent}%` }} />}
            <FileVideo className={cx("relative h-4 w-4 shrink-0", it.state === "done" ? "text-emerald-400" : "text-sky-400")} />
            <div className="relative min-w-[220px] flex-1">
              <div className="truncate font-mono text-sm text-zinc-100" title={it.path}>
                {convertedName(it.name)}
                {convertedName(it.name) !== it.name && <span className="ml-2 text-xs text-zinc-600">{it.name}</span>}
              </div>
              <div className="truncate font-mono text-[11px] text-zinc-600" title={it.outPath ?? it.out}>
                {it.quality}p → {it.outPath ?? it.out}
              </div>
            </div>
            <span className="relative w-24 shrink-0 text-right font-mono text-xs text-zinc-500">
              {it.outSize ? (
                <>
                  → <span className="text-emerald-400">{fmtSize(it.outSize)}</span>
                </>
              ) : (
                fmtSize(it.size)
              )}
            </span>
            <span className="relative flex w-52 shrink-0 items-center justify-end gap-2 text-xs">
              <ItemStatus item={it} />
              {!finished(it.state) ? (
                <button type="button" title="Цуцлах" onClick={() => cancel(it.id)} className="rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-red-300">
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : (
                (it.state === "failed" || it.state === "cancelled") && (
                  <button type="button" onClick={() => retry(it.id)} className="rounded-md px-1.5 py-0.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-white">
                    Дахин
                  </button>
                )
              )}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function ItemStatus({ item }: { item: QueueItem }) {
  switch (item.state) {
    case "waiting":
      return <span className="text-zinc-500">Дараалалд</span>;
    case "running":
      return (
        <span className="inline-flex items-center gap-1.5 text-violet-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {Math.round(item.percent)}%
          {item.speed ? <span className="font-mono text-zinc-500">{item.speed.toFixed(1)}×</span> : null}
        </span>
      );
    case "done":
      return (
        <span className="inline-flex items-center gap-1.5 text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" /> Бэлэн
        </span>
      );
    case "skipped":
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-zinc-400" title={item.message}>
          <SkipForward className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">Аль хэдийн бий</span>
        </span>
      );
    case "cancelled":
      return (
        <span className="inline-flex items-center gap-1.5 text-zinc-500">
          <AlertTriangle className="h-3.5 w-3.5" /> Цуцалсан
        </span>
      );
    case "failed":
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-red-400" title={item.message}>
          <XCircle className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{item.message}</span>
        </span>
      );
  }
}
