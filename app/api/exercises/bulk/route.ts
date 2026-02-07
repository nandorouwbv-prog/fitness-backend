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

// cache for full exercise list
g.__exerciseAllCache ??= null as null | { value: Exercise[]; expiresAt: number };

const TTL_MS = 1000 * 60 * 60 * 24; // 24h
const ALL_TTL_MS = 1000 * 60 * 60 * 6; // 6h

const VERSION = "bulk-v5-pagination+scoring";

function normName(s: string) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cacheGet(key: string) {
  const hit = nameCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    nameCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: any) {
  nameCache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

function getHeaders() {
  const RAPIDAPI_KEY = process.env.EXERCISEDB_RAPIDAPI_KEY;
  if (!RAPIDAPI_KEY) throw new Error("Missing EXERCISEDB_RAPIDAPI_KEY env var");

  return {
    "X-RapidAPI-Key": RAPIDAPI_KEY,
    "X-RapidAPI-Host": "exercisedb.p.rapidapi.com",
    Accept: "application/json",
  };
}

async function fetchJson(url: string) {
  const headers = getHeaders();
  const res = await fetch(url, { headers, cache: "no-store" });

  const contentType = res.headers.get("content-type") ?? "";
  let json: any = null;
  let text: string | null = null;

  if (contentType.includes("application/json")) {
    json = await res.json().catch(() => null);
  } else {
    text = await res.text().catch(() => null);
  }

  return {
    ok: res.ok,
    status: res.status,
    json,
    text,
  };
}

/**
 * Name endpoint lookup (fast path)
 */
async function fetchByNameOnce(query: string) {
  const q = normName(query);
  if (!q) return { ex: null as Exercise | null, dbg: { step: "bad-query" } };

  const url =
    `https://exercisedb.p.rapidapi.com/exercises/name/` +
    encodeURIComponent(q) +
    `?limit=10&offset=0`;

  const r = await fetchJson(url);

  if (!r.ok) {
    return {
      ex: null,
      dbg: {
        step: "name-fail",
        query: q,
        status: r.status,
        snippet: (r.text ?? JSON.stringify(r.json) ?? "").slice(0, 200),
      },
    };
  }

  const data = r.json as Exercise[] | null;
  if (!Array.isArray(data) || data.length === 0) {
    return {
      ex: null,
      dbg: { step: "name-empty", query: q, status: r.status },
    };
  }

  const lower = q;

const exact = data.find((x) => normName(x?.name) === lower);
if (exact) return { ex: exact, dbg: { step: "name-exact", query: q } };

// ✅ pick best match by score (prevents wrong exerciseIds/images)
let best: Exercise | null = null;
let bestScore = -1;

for (const ex of data) {
const s = scoreMatchEx(q, ex);

  if (s > bestScore) {
    bestScore = s;
    best = ex;
  }
}

// If score is very low, treat as not found
if (!best || bestScore < 8) {
  return {
    ex: null,
    dbg: { step: "name-scored-none", query: q, count: data.length, bestScore },
  };
}

return {
  ex: best,
  dbg: {
    step: "name-scored",
    query: q,
    count: data.length,
    bestScore,
    bestName: best.name,
    bestEquipment: best.equipment,
  },
};

}

/**
 * ✅ FULL LIST (paged)
 * Rapid’s /exercises usually defaults to 10 → MUST page.
 */
async function fetchAllExercisesPaged(): Promise<{ list: Exercise[] | null; dbg: any }> {
  const now = Date.now();
  const cached = g.__exerciseAllCache as null | { value: Exercise[]; expiresAt: number };
  if (cached && now < cached.expiresAt) {
    return { list: cached.value, dbg: { step: "all-cache", count: cached.value.length } };
  }

  const limit = 200;
  let offset = 0;
  const all: Exercise[] = [];

  // hard safety cap
  const MAX_PAGES = 20; // 20*200 = 4000

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://exercisedb.p.rapidapi.com/exercises?limit=${limit}&offset=${offset}`;
    const r = await fetchJson(url);

    if (!r.ok) {
      return {
        list: null,
        dbg: {
          step: "all-fail",
          status: r.status,
          offset,
          snippet: (r.text ?? JSON.stringify(r.json) ?? "").slice(0, 200),
        },
      };
    }

    const batch = r.json as Exercise[] | null;
    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch);

    if (batch.length < limit) break;
    offset += limit;
  }

  if (all.length === 0) return { list: null, dbg: { step: "all-empty" } };

  g.__exerciseAllCache = { value: all, expiresAt: now + ALL_TTL_MS };
  return { list: all, dbg: { step: "all-ok", count: all.length } };
}

/**
 * Better fuzzy match:
 * Score by:
 * - exact token overlap
 * - query included in name
 * - small bonus for barbell/dumbbell if query generic
 */
function scoreMatchEx(query: string, ex: Exercise) {
  const q = normName(query);
  const n = normName(ex?.name ?? "");
  const equip = normName(ex?.equipment ?? "");
  const target = normName(ex?.target ?? "");

  if (!q || !n) return -1;
  if (n === q) return 999;

  const qTokens = q.split(" ").filter(Boolean);
  const nTokens = n.split(" ").filter(Boolean);

  let overlap = 0;
  for (const t of qTokens) if (nTokens.includes(t)) overlap++;

  // base score
  let score = overlap * 12;

  if (n.includes(q)) score += 25;
  if (qTokens.length > 0) score += Math.round((overlap / qTokens.length) * 12);

  // ✅ HARD hints from query
  const wantsDumbbell = qTokens.includes("dumbbell");
  const wantsBarbell = qTokens.includes("barbell");
  const wantsCable = qTokens.includes("cable");
  const wantsMachine = qTokens.includes("machine");
  const wantsBiceps = qTokens.includes("bicep") || qTokens.includes("biceps");

  if (wantsDumbbell) score += equip.includes("dumbbell") ? 30 : -20;
  if (wantsBarbell) score += equip.includes("barbell") ? 30 : -20;
  if (wantsCable) score += equip.includes("cable") ? 30 : -20;
  if (wantsMachine) score += (equip.includes("machine") || equip.includes("leverage")) ? 25 : -15;

  if (wantsBiceps) score += target.includes("biceps") ? 25 : -15;

  // slight penalty for very long names when query is short
  if (qTokens.length <= 2 && nTokens.length >= 5) score -= 3;

  return score;
}


async function fetchByName(query: string) {
  const q = normName(query);
  if (!q) return { ex: null as Exercise | null, dbg: { step: "bad-query" } };

  // 1) name endpoint first
  const primary = await fetchByNameOnce(q);
  if (primary.ex) return primary;

  // 2) small prefix fallbacks
  const tryBarbell = await fetchByNameOnce(`barbell ${q}`);
  if (tryBarbell.ex) return { ex: tryBarbell.ex, dbg: { step: "prefix-barbell", from: primary.dbg } };

  const tryDumbbell = await fetchByNameOnce(`dumbbell ${q}`);
  if (tryDumbbell.ex) return { ex: tryDumbbell.ex, dbg: { step: "prefix-dumbbell", from: primary.dbg } };

  // 3) full list + scoring
  const allRes = await fetchAllExercisesPaged();
  if (!allRes.list) {
    return { ex: null, dbg: { step: "all-unavailable", primary: primary.dbg, all: allRes.dbg } };
  }

  const all = allRes.list;

  let best: Exercise | null = null;
  let bestScore = -1;

  for (const ex of all) {
  const s = scoreMatchEx(q, ex);
    if (s > bestScore) {
      bestScore = s;
      best = ex;
    }
  }

  // if best score is too low, treat as not found
  if (!best || bestScore < 8) {
    return { ex: null, dbg: { step: "all-none", count: all.length, tried: q, bestScore } };
  }

  return {
    ex: best,
    dbg: { step: "all-scored", count: all.length, tried: q, bestScore, bestName: best.name },
  };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;

    const rawNames: string[] = Array.isArray(body?.names)
      ? body.names.filter((x: any) => typeof x === "string")
      : [];

    const debug = Boolean(body?.debug);
    const refresh = Boolean(body?.refresh);

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
    const debugInfo: Record<string, any> = {};

    const CONCURRENCY = 3;
    let cursor = 0;

    async function worker() {
      while (cursor < uniqueKeys.length) {
        const idx = cursor++;
        const key = uniqueKeys[idx];
        const originalName = keyToOriginal.get(key) ?? key;

        if (!refresh) {
          const cached = cacheGet(key);
          if (cached !== undefined) {
            results[originalName] = cached;
            if (debug) debugInfo[originalName] = { step: "cache-hit" };
            continue;
          }
        }

        const r = await fetchByName(key);
        const ex = r.ex;

        if (!ex) {
          if (!debug) cacheSet(key, null);
          results[originalName] = null;
          if (debug) debugInfo[originalName] = r.dbg;
          continue;
        }

        const imageUrl = `/api/exercises/image?exerciseId=${encodeURIComponent(ex.id)}&resolution=180`;

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
        if (debug) debugInfo[originalName] = r.dbg;
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    return NextResponse.json(
      debug
        ? { ok: true, version: VERSION, results, debug: debugInfo }
        : { ok: true, version: VERSION, results }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
