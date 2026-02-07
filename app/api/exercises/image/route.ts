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

// simpele SVG placeholder
function placeholderSvg(label: string) {
  const safe = String(label ?? "Exercise").slice(0, 28);
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">
    <rect width="100%" height="100%" rx="24" ry="24" fill="#EEEEEE"/>
    <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle"
      font-family="Arial" font-size="14" fill="#666666">${safe}</text>
  </svg>
  `.trim();
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

    // 3) if no body -> placeholder
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

    // 4) IMPORTANT: only pass through if it's really an image
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      const svg = placeholderSvg(`ID ${exerciseId}`);
      return new NextResponse(svg, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml",
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
