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

  return fetch(url, { headers: getHeaders(), cache: "no-store" });
}

// 1x1 transparent png
function placeholderPng() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
    "base64"
  );
}

function placeholderPngResponse(cacheControl = "public, max-age=86400, s-maxage=86400") {
  const png = placeholderPng();
  return new NextResponse(png, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": cacheControl,
    },
  });
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const exerciseId = searchParams.get("exerciseId");
    const requestedRes = searchParams.get("resolution") ?? "360";

    if (!exerciseId) {
      return NextResponse.json({ ok: false, error: "Missing exerciseId" }, { status: 400 });
    }

    // ✅ try requested first, then fallback high→low
    const attempts = Array.from(
      new Set([requestedRes, "360", "180", "90"].map(String))
    );

    let upstream: Response | null = null;

    for (const r of attempts) {
      const res = await fetchImage(exerciseId, r);
      if (res.ok && res.body) {
        upstream = res;
        break;
      }
    }

    if (!upstream) return placeholderPngResponse();

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return placeholderPngResponse();

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
      },
    });
  } catch {
    return placeholderPngResponse("no-store");
  }
}
