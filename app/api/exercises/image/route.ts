import { NextResponse } from "next/server";

function getHeaders() {
  const key = process.env.EXERCISEDB_RAPIDAPI_KEY;
  if (!key) throw new Error("Missing EXERCISEDB_RAPIDAPI_KEY");

  return {
    "X-RapidAPI-Key": key,
    "X-RapidAPI-Host": "exercisedb.p.rapidapi.com",
    Accept: "image/*",
  };
}

async function fetchImage(exerciseId: string, resolution?: string) {
  const base = "https://exercisedb.p.rapidapi.com/image";
  const url =
    resolution && resolution.length > 0
      ? `${base}?exerciseId=${encodeURIComponent(exerciseId)}&resolution=${encodeURIComponent(resolution)}`
      : `${base}?exerciseId=${encodeURIComponent(exerciseId)}`;

  return fetch(url, { headers: getHeaders(), cache: "no-store" });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const exerciseId = searchParams.get("exerciseId");
  const resolution = searchParams.get("resolution") ?? undefined;

  if (!exerciseId) {
    return NextResponse.json(
      { ok: false, error: "Missing exerciseId" },
      { status: 400 }
    );
  }

  // 1) ✅ eerst zonder resolution (hoogste hit rate)
  let upstream = await fetchImage(exerciseId);

  // 2) als dat faalt: probeer requested resolution (als die meegegeven werd)
  if (!upstream.ok && resolution) {
    upstream = await fetchImage(exerciseId, resolution);
  }

  // 3) als dat faalt: fallback resoluties
  if (!upstream.ok) {
    for (const r of ["180", "360", "90"]) {
      const attempt = await fetchImage(exerciseId, r);
      if (attempt.ok) {
        upstream = attempt;
        break;
      }
    }
  }

  if (!upstream.ok || !upstream.body) {
    const snippet = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        ok: false,
        error: `Image not available (${upstream.status})`,
        snippet: snippet.slice(0, 120),
      },
      { status: 404 }
    );
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
    },
  });
}
