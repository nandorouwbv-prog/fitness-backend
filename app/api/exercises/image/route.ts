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

async function fetchImage(exerciseId: string, resolution: string) {
  const url =
    "https://exercisedb.p.rapidapi.com/image" +
    `?exerciseId=${encodeURIComponent(exerciseId)}` +
    `&resolution=${encodeURIComponent(resolution)}`;

  return fetch(url, {
    headers: getHeaders(),
    cache: "no-store",
  });
}

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

  // 1️⃣ probeer gevraagde resolutie (meestal 180)
  let upstream = await fetchImage(exerciseId, resolution);

  // 2️⃣ fallback resoluties (cruciaal voor push-ups & deadlifts)
  if (!upstream.ok) {
    for (const r of ["360", "90"]) {
      const attempt = await fetchImage(exerciseId, r);
      if (attempt.ok) {
        upstream = attempt;
        break;
      }
    }
  }

  // 3️⃣ als er écht geen image bestaat
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { ok: false, error: "Image not available" },
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
