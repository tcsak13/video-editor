"use client";

import dynamic from "next/dynamic";

// Remembers the chosen folders in localStorage, so it only runs client-side.
const MergeTool = dynamic(() => import("@/components/merge/MergeTool"), {
  ssr: false,
  loading: () => <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Ачаалж байна…</div>,
});

export default function Page() {
  return <MergeTool />;
}
