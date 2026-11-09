export function fmtDur(sec: number) {
  const s = Math.round(sec);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtSize(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

export function fmtEta(ms: number) {
  const s = Math.round(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)} цаг ${Math.floor((s % 3600) / 60)} мин`;
  return s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} сек` : `${s} сек`;
}
