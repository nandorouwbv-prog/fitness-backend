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

async function fetchImage(
  exerciseId: string,
  resolution: string,
  method: "GET" | "HEAD" = "GET"
) {
  const url =
    "https://exercisedb.p.rapidapi.com/image" +
    `?exerciseId=${encodeURIComponent(exerciseId)}` +
    `&resolution=${encodeURIComponent(resolution)}`;

  return fetch(url, {
    method,
    headers: getHeaders(),
    cache: "no-store",
  });
}

// ✅ super simpele SVG placeholder (geen extra files nodig)
function placeholderSvg(label: string) {
  const safe = String(label ?? "Exercise")
    .replace(/[<>&"]/g, "")
    .slice(0, 28);

  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">
    <rect width="100%" height="100%" rx="24" ry="24" fill="#EEEEEE"/>
    <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle"
      font-family="Arial" font-size="14" fill="#666666">${safe}</text>
  </svg>
  `.trim();
}

/**
 * ✅ expo-image doet vaak HEAD om te checken of de image bestaat.
 * Als jouw route geen HEAD heeft → Next geeft 404 → expo-image faalt.
 *
 * We geven daarom altijd 200 terug zodat expo-image door kan met GET.
 */
export async function HEAD(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const exerciseId = searchParams.get("exerciseId");
    const requestedRes = searchParams.get("resolution") ?? "180";

    if (!exerciseId) {
      return new NextResponse(null, { status: 200 });
    }

    // probeer HEAD op requested + fallbacks (maar we blijven “soft”)
    let upstream = await fetchImage(exerciseId, requestedRes, "HEAD");

    if (!upstream.ok) {
      for (const r of ["360", "180", "90"]) {
        const attempt = await fetchImage(exerciseId, r, "HEAD");
        if (attempt.ok) {
          upstream = attempt;
          break;
        }
      }
    }

    return new NextResponse(null, {
      status: 200, // ⚠️ altijd 200 zodat expo-image niet stopt
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/*",
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
      },
    });
  } catch {
    return new NextResponse(null, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
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

    // 1) try requested
    let upstream = await fetchImage(exerciseId, requestedRes, "GET");

    // 2) fallback resolutions (cruciaal!)
    if (!upstream.ok) {
      for (const r of ["360", "180", "90"]) {
        const attempt = await fetchImage(exerciseId, r, "GET");
        if (attempt.ok) {
          upstream = attempt;
          break;
        }
      }
    }

    // 3) if still no image → return placeholder (NO 404)
    if (!upstream.ok || !upstream.body) {
      const svg = placeholderSvg(`ID ${exerciseId}`);
      return new NextResponse(svg, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400, s-maxage=86400",
        },
      });
    }

    const contentType =
      upstream.headers.get("content-type") ?? "application/octet-stream";

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
      },
    });
  } catch (e: any) {
    // ✅ ook bij errors: placeholder i.p.v. 500/404 → app blijft netjes
    const svg = placeholderSvg("No image");
    return new NextResponse(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "no-store",
      },
    });
  }
}
