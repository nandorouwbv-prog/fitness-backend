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

// ✅ cache for the full exercise list (used for fuzzy fallback)
g.__exerciseAllCache ??= null as null | { value: Exercise[]; expiresAt: number };

const TTL_MS = 1000 * 60 * 60 * 24; // 24h
const ALL_TTL_MS = 1000 * 60 * 60 * 6; // 6h

function normName(s: string) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cacheGet(key: string) {
  const hit = nameCache.get(key);
  if (!hit) return undefined; // undefined => not cached; null can be cached value
  if (Date.now() > hit.expiresAt) {
    nameCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: any) {
  nameCache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/**
 * ✅ Robust headers for RapidAPI in Vercel/Next runtimes:
 * use Headers() + Accept to prevent weird stripping / mismatch.
 */
function getRapidHeaders() {
  const RAPIDAPI_KEY = process.env.EXERCISEDB_RAPIDAPI_KEY;
  if (!RAPIDAPI_KEY) throw new Error("Missing EXERCISEDB_RAPIDAPI_KEY env var");

  const h = new Headers();
  h.set("X-RapidAPI-Key", RAPIDAPI_KEY);
  h.set("X-RapidAPI-Host", "exercisedb.p.rapidapi.com");
  h.set("Accept", "application/json");
  return h;
}

async function fetchByNameOnce(query: string): Promise<Exercise | null> {
  const headers = getRapidHeaders();

  const url =
    "https://exercisedb.p.rapidapi.com/exercises/name/" +
    encodeURIComponent(query);

  const res = await fetch(url, {
    method: "GET",
    headers,
    cache: "no-store",
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.log("[ExerciseDB] name lookup failed", {
      query,
      status: res.status,
      body: txt.slice(0, 200),
    });
    return null;
  }

  const data = (await res.json().catch(() => null)) as Exercise[] | null;
  if (!Array.isArray(data) || data.length === 0) return null;

  const lower = query.toLowerCase().trim();

  const exact = data.find(
    (x) => String(x?.name ?? "").toLowerCase().trim() === lower
  );
  if (exact) return exact;

  const preferred = data.find((x) =>
    ["barbell", "dumbbell", "machine", "body weight"].includes(
      String(x?.equipment ?? "").toLowerCase().trim()
    )
  );

  return preferred ?? data[0] ?? null;
}

// ✅ Fetch all exercises once (cached) for fuzzy matching
async function fetchAllExercises(): Promise<Exercise[] | null> {
  const now = Date.now();
  const cached = g.__exerciseAllCache as
    | null
    | { value: Exercise[]; expiresAt: number };

  if (cached && now < cached.expiresAt) return cached.value;

  const headers = getRapidHeaders();

  // Some variants are happier with pagination params
  const url = "https://exercisedb.p.rapidapi.com/exercises?limit=1500&offset=0";

  const res = await fetch(url, {
    method: "GET",
    headers,
    cache: "no-store",
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.log("[ExerciseDB] all exercises fetch failed", {
      status: res.status,
      body: txt.slice(0, 200),
    });
    return null;
  }

  const data = (await res.json().catch(() => null)) as Exercise[] | null;
  if (!Array.isArray(data) || data.length === 0) return null;

  g.__exerciseAllCache = { value: data, expiresAt: now + ALL_TTL_MS };
  return data;
}

/**
 * fetchByName:
 * - try name endpoint first (fast)
 * - if that fails: fuzzy match inside full list (robust for AI names)
 */
async function fetchByName(query: string): Promise<Exercise | null> {
  const q = normName(query);
  if (!q) return null;

  // 1) primary: name endpoint
  const primary = await fetchByNameOnce(q);
  if (primary) return primary;

  // 2) cheap prefix fallbacks
  const tryBarbell = await fetchByNameOnce(`barbell ${q}`);
  if (tryBarbell) return tryBarbell;

  const tryDumbbell = await fetchByNameOnce(`dumbbell ${q}`);
  if (tryDumbbell) return tryDumbbell;

  // 3) robust fallback: full list + fuzzy match
  const all = await fetchAllExercises();
  if (!all) return null;

  const lower = q;

  const exact = all.find(
    (x) => String(x?.name ?? "").toLowerCase().trim() === lower
  );
  if (exact) return exact;

  const includes = all.find((x) =>
    String(x?.name ?? "").toLowerCase().includes(lower)
  );
  if (includes) return includes;

  const reverse = all.find((x) =>
    lower.includes(String(x?.name ?? "").toLowerCase().trim())
  );

  return reverse ?? null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;

    const rawNames: string[] = Array.isArray(body?.names)
      ? body.names.filter((x: any) => typeof x === "string")
      : [];

    if (rawNames.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Invalid payload. Expected { names: string[] }" },
        { status: 400 }
      );
    }

    const uniqueKeys = Array.from(new Set(rawNames.map(normName))).filter(Boolean);

    const keyToOriginal = new Map<string, string>();
    for (const n of rawNames) {
      const k = normName(n);
      if (k && !keyToOriginal.has(k)) keyToOriginal.set(k, n);
    }

    const results: Record<string, any> = {};

    // keep RapidAPI happy
    const CONCURRENCY = 3;
    let cursor = 0;

    async function worker() {
      while (cursor < uniqueKeys.length) {
        const idx = cursor++;
        const key = uniqueKeys[idx];
        const originalName = keyToOriginal.get(key) ?? key;

        const cached = cacheGet(key);
        if (cached !== undefined) {
          results[originalName] = cached;
          continue;
        }

        const ex = await fetchByName(key);
        if (!ex) {
          cacheSet(key, null);
          results[originalName] = null;
          continue;
        }

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

  await Promise.all(
  Array.from({ length: CONCURRENCY }, () => worker())
);


    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
