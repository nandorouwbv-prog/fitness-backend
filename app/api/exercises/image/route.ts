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

// ✅ PNG placeholder (expo-image safe). 1x1 transparant.
function placeholderPng() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
    "base64"
  );
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const exerciseId = searchParams.get("exerciseId");
    const requestedRes = searchParams.get("resolution") ?? "180";

    if (!exerciseId) {
      return NextResponse.json(
        { ok: false, error: "Missing exerciseId" },
        { status: 400 }
      );
    }

    // 1) try requested res
    let upstream = await fetchImage(exerciseId, requestedRes);

    // 2) fallback resolutions
    if (!upstream.ok) {
      for (const r of ["360", "90"]) {
        const attempt = await fetchImage(exerciseId, r);
        if (attempt.ok) {
          upstream = attempt;
          break;
        }
      }
    }

    // 3) if still no image/body -> PNG placeholder (NO 404)
    if (!upstream.ok || !upstream.body) {
      const png = placeholderPng();
      return new NextResponse(png, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400, s-maxage=86400",
        },
      });
    }

    // 4) only pass through if it's actually an image
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      const png = placeholderPng();
      return new NextResponse(png, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400, s-maxage=86400",
        },
      });
    }

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
      },
    });
  } catch {
    // ✅ also return PNG placeholder on errors
    const png = placeholderPng();
    return new NextResponse(png, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
    });
  }
}
