import { NextResponse } from "next/server";

type Exercise = {
  id: string;
  name: string;
  bodyPart?: string;
  target?: string;
  equipment?: string;
  secondaryMuscles?: string[];
  instructions?: string[];
  description?: string;
  difficulty?: string;
  category?: string;
};

type CacheEntry = { value: any; expiresAt: number };

// ---- simple in-memory cache (works per server instance)
const g = globalThis as any;
g.__exerciseNameCache ??= new Map<string, CacheEntry>();
const nameCache: Map<string, CacheEntry> = g.__exerciseNameCache;

const TTL_MS = 1000 * 60 * 60 * 24; // 24h

function normName(s: string) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cacheGet(key: string) {
  const hit = nameCache.get(key);
  if (!hit) return undefined; // <— use undefined so null can be a cached value
  if (Date.now() > hit.expiresAt) {
    nameCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: any) {
  nameCache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

async function fetchByName(name: string): Promise<Exercise | null> {
  const RAPIDAPI_KEY = process.env.EXERCISEDB_RAPIDAPI_KEY;
  if (!RAPIDAPI_KEY) throw new Error("Missing EXERCISEDB_RAPIDAPI_KEY env var");

  // ExerciseDB: GET /exercises/name/{name}
  const url =
    `https://exercisedb.p.rapidapi.com/exercises/name/` +
    encodeURIComponent(name) +
    `?limit=1&offset=0`;

  const res = await fetch(url, {
    headers: { "X-RapidAPI-Key": RAPIDAPI_KEY },
    cache: "no-store",
  });

  if (!res.ok) return null;

  const data = (await res.json().catch(() => null)) as Exercise[] | null;
  if (!Array.isArray(data) || data.length === 0) return null;

  return data[0] ?? null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;

    // ✅ Hard-typed list
    const rawNames: string[] = Array.isArray(body?.names)
      ? body.names.filter((x: any) => typeof x === "string")
      : [];

    if (rawNames.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Invalid payload. Expected { names: string[] }" },
        { status: 400 }
      );
    }

    // unique normalized keys
    const uniqueKeys = Array.from(new Set(rawNames.map(normName))).filter(Boolean);

    // map normalized key -> original label (first match)
    const keyToOriginal = new Map<string, string>();
    for (const n of rawNames) {
      const k = normName(n);
      if (k && !keyToOriginal.has(k)) keyToOriginal.set(k, n);
    }

    const results: Record<string, any> = {};

    // small concurrency limit (keeps RapidAPI happy)
    const CONCURRENCY = 3;
    let cursor = 0;

    async function worker() {
      while (cursor < uniqueKeys.length) {
        const idx = cursor++;
        const key = uniqueKeys[idx];
        const originalName = keyToOriginal.get(key) ?? key;

        const cached = cacheGet(key);
        if (cached !== undefined) {
          results[originalName] = cached; // can be null or object
          continue;
        }

        const ex = await fetchByName(originalName);
        if (!ex) {
          cacheSet(key, null);
          results[originalName] = null;
          continue;
        }

        // Return OUR proxy image endpoint
        const imageUrl = `/api/exercises/image?exerciseId=${encodeURIComponent(
          ex.id
        )}&resolution=180`;

        const shaped = {
          id: ex.id,
          name: ex.name,
          bodyPart: ex.bodyPart,
          target: ex.target,
          equipment: ex.equipment,
          difficulty: ex.difficulty,
          category: ex.category,
          imageUrl,
        };

        cacheSet(key, shaped);
        results[originalName] = shaped;
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
