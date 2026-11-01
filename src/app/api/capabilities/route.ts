import { availableEncoders } from "@/lib/server/ffmpeg";
import { rejectNonLocal } from "@/lib/server/storage";

// GET /api/capabilities — which encoders the bundled ffmpeg supports on this machine.
export async function GET(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;
  return Response.json({
    encoders: await availableEncoders(),
    platform: process.platform,
    arch: process.arch,
  });
}
