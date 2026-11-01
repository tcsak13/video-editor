"use client";

import dynamic from "next/dynamic";

// The editor reads localStorage and browser media APIs on first render, so it only runs client-side.
const Editor = dynamic(() => import("@/components/editor/Editor"), {
  ssr: false,
  loading: () => <div className="flex h-screen items-center justify-center bg-[#0b0b0f] text-sm text-zinc-500">Ачаалж байна…</div>,
});

export default function Page() {
  return <Editor />;
}
