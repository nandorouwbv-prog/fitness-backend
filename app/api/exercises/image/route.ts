import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const exerciseId = searchParams.get("exerciseId");
  const resolution = searchParams.get("resolution") ?? "180";

  if (!exerciseId) {
    return NextResponse.json(
      { ok: false, error: "Missing exerciseId" },
      { status: 400 }
    );
  }

  const RAPIDAPI_KEY = process.env.EXERCISEDB_RAPIDAPI_KEY;
  if (!RAPIDAPI_KEY) {
    return NextResponse.json(
      { ok: false, error: "Missing EXERCISEDB_RAPIDAPI_KEY env var" },
      { status: 500 }
    );
  }

  // ExerciseDB Image Service: GET /image?exerciseId=...&resolution=...
  const url = `https://exercisedb.p.rapidapi.com/image?exerciseId=${encodeURIComponent(
    exerciseId
  )}&resolution=${encodeURIComponent(resolution)}`;

  const upstream = await fetch(url, {
    headers: { "X-RapidAPI-Key": RAPIDAPI_KEY },
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { ok: false, error: `Image fetch failed (${upstream.status})` },
      { status: 502 }
    );
  }

  // Stream GIF through your backend
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      // CDN-friendly cache (safe because url includes exerciseId+resolution)
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
    },
  });
}
