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

// ✅ bumped
const VERSION = "bulk-v10-benchGuards+canonical";

/** -------------------------------------------------------
 * Helpers
 * ------------------------------------------------------ */
function normName(s: string) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * ✅ Canonicalize plan exercise names → ExerciseDB-friendly queries
 * This is the #1 place to fix mismatches like "Flat Dumbbell Press".
 */
function canonicalQuery(raw: string) {
  const q = normName(raw);

  const map: Record<string, string> = {
    // curls
    "dumbbell bicep curl": "dumbbell curl",
    "dumbbell biceps curl": "dumbbell curl",
    "bicep curl": "dumbbell curl",
    "hammer curl": "dumbbell hammer curl",

    // pushups
    "push-up": "push-up",
    "push up": "push-up",
    pushup: "push-up",
    "bodyweight push up": "push-up",
    "push-ups": "push-up",
    "push ups": "push-up",

    // deadlifts
    "deadlift ( light weight )": "deadlift",
    "deadlift (light weight)": "deadlift",
    "deadlift light weight": "deadlift",
    "light weight deadlift": "deadlift",
    deadlifts: "deadlift",
    "deadlifts (light weight)": "deadlift",
    "deadlifts ( light weight )": "deadlift",

    // pulldown
    "lat pulldown": "lat pulldown",

    // ✅ BENCH / PRESSES (fix your mismatch)
    "flat dumbbell press": "dumbbell bench press",
    "dumbbell bench press": "dumbbell bench press",
    "flat db press": "dumbbell bench press",
    "incline barbell bench press": "incline bench press",
    "incline barbell press": "incline bench press",

    // dips
    "chest dips": "dips",
  };

  return map[q] ?? q;
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
 * Better fuzzy match (uses equipment/target too)
 * ✅ Added bench/chest intent guard + flat incline/decline penalties
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

  let score = overlap * 12;

  if (n.includes(q)) score += 25;
  if (qTokens.length > 0) score += Math.round((overlap / qTokens.length) * 12);

  // HARD query hints → equipment/target sanity
  const wantsDumbbell = qTokens.includes("dumbbell");
  const wantsBarbell = qTokens.includes("barbell");
  const wantsCable = qTokens.includes("cable");
  const wantsMachine = qTokens.includes("machine");
  const wantsBiceps = qTokens.includes("bicep") || qTokens.includes("biceps");

  if (wantsDumbbell) score += equip.includes("dumbbell") ? 30 : -20;
  if (wantsBarbell) score += equip.includes("barbell") ? 30 : -20;
  if (wantsCable) score += equip.includes("cable") ? 30 : -20;
  if (wantsMachine)
    score += equip.includes("machine") || equip.includes("leverage") ? 25 : -15;

  if (wantsBiceps) score += target.includes("biceps") ? 25 : -15;

  // ✅ BENCH/CHEST intent guard (prevents weird matches)
  const wantsBench =
    qTokens.includes("bench") || qTokens.includes("press") || qTokens.includes("chest");

  const isChestTarget = target.includes("pectorals") || target.includes("chest");
  const isShoulderTarget =
    target.includes("delts") || target.includes("shoulders") || target.includes("shoulder");

  if (wantsBench) {
    score += isChestTarget ? 22 : -10;
    if (isShoulderTarget) score -= 18;
  }

  // ✅ "flat" hint → penalize incline/decline names when possible
  if (qTokens.includes("flat")) {
    if (n.includes("incline") || n.includes("decline")) score -= 12;
  }

  if (qTokens.length <= 2 && nTokens.length >= 5) score -= 3;

  return score;
}

/* -------------------------------------------------------
   ✅ pick exercise that actually has the BEST image resolution
-------------------------------------------------------- */

// cache best resolution per exerciseId (per instance)
type ImgCacheEntry = { res: string | null; expiresAt: number };
g.__exerciseImgCache ??= new Map<string, ImgCacheEntry>();
const imgCache: Map<string, ImgCacheEntry> = g.__exerciseImgCache;

const IMG_TTL_MS = 1000 * 60 * 60 * 24; // 24h

function imgCacheGet(id: string) {
  const hit = imgCache.get(id);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    imgCache.delete(id);
    return undefined;
  }
  return hit.res;
}

function imgCacheSet(id: string, res: string | null) {
  imgCache.set(id, { res, expiresAt: Date.now() + IMG_TTL_MS });
}

/** ✅ Returns best available resolution: "360" | "180" | "90" | null */
async function getBestImageResolution(exerciseId: string): Promise<string | null> {
  const cached = imgCacheGet(exerciseId);
  if (cached !== undefined) return cached; // can be null

  const headers = {
    ...getHeaders(),
    Accept: "image/*",
  };

  const base = "https://exercisedb.p.rapidapi.com/image?exerciseId=";

  // ✅ try high → low
  for (const res of ["360", "180", "90"]) {
    const url = `${base}${encodeURIComponent(exerciseId)}&resolution=${res}`;
    const r = await fetch(url, { headers, cache: "no-store" });
    if (r.ok) {
      imgCacheSet(exerciseId, res);
      return res;
    }
  }

  imgCacheSet(exerciseId, null);
  return null;
}

async function pickBestWithImage(query: string, candidates: Exercise[]) {
  const scored = candidates
    .map((ex) => ({ ex, score: scoreMatchEx(query, ex) }))
    .sort((a, b) => b.score - a.score);

  const TOP_N = 6;

  for (const item of scored.slice(0, TOP_N)) {
    if (item.score < 8) break;

    const bestRes = await getBestImageResolution(item.ex.id);
    if (bestRes) return { ex: item.ex, bestRes };
  }

  // fallback: return best even if no image
  const best = scored[0];
  if (!best || best.score < 8) return null;

  const bestRes = await getBestImageResolution(best.ex.id);
  return { ex: best.ex, bestRes: bestRes ?? null };
}

/**
 * Name endpoint lookup (fast path)
 */
async function fetchByNameOnce(query: string) {
  const q = canonicalQuery(query);
  if (!q)
    return {
      ex: null as Exercise | null,
      bestRes: null as string | null,
      dbg: { step: "bad-query" },
    };

  const url =
    `https://exercisedb.p.rapidapi.com/exercises/name/` +
    encodeURIComponent(q) +
    `?limit=10&offset=0`;

  const r = await fetchJson(url);

  if (!r.ok) {
    return {
      ex: null,
      bestRes: null,
      dbg: {
        step: "name-fail",
        query: q,
        status: r.status,
        snippet: (r.text ?? JSON.stringify(r.json) ?? "").slice(0, 200),
      },
    };
  }

  let data = r.json as Exercise[] | null;
  if (!Array.isArray(data) || data.length === 0) {
    return {
      ex: null,
      bestRes: null,
      dbg: { step: "name-empty", query: q, status: r.status },
    };
  }

  const lower = q;
  const exact = data.find((x) => normName(x?.name) === lower);

  if (exact) {
    const bestRes = await getBestImageResolution(exact.id);
    if (bestRes)
      return {
        ex: exact,
        bestRes,
        dbg: { step: "name-exact+bestRes", query: q, bestRes },
      };
    // if exact has no image, fallthrough to pick best with image
  }

  // HARD FILTERS
  const qTokens = lower.split(" ").filter(Boolean);
  const wantsDumbbell = qTokens.includes("dumbbell");
  const wantsBarbell = qTokens.includes("barbell");
  const wantsCable = qTokens.includes("cable");
  const wantsMachine = qTokens.includes("machine");
  const wantsBiceps = qTokens.includes("bicep") || qTokens.includes("biceps");

  const origCount = data.length;

  if (wantsDumbbell) {
    const filtered = data.filter((x) => normName(x?.equipment ?? "").includes("dumbbell"));
    if (filtered.length > 0) data = filtered;
  }
  if (wantsBarbell) {
    const filtered = data.filter((x) => normName(x?.equipment ?? "").includes("barbell"));
    if (filtered.length > 0) data = filtered;
  }
  if (wantsCable) {
    const filtered = data.filter((x) => normName(x?.equipment ?? "").includes("cable"));
    if (filtered.length > 0) data = filtered;
  }
  if (wantsMachine) {
    const filtered = data.filter((x) => {
      const e = normName(x?.equipment ?? "");
      return e.includes("machine") || e.includes("leverage");
    });
    if (filtered.length > 0) data = filtered;
  }
  if (wantsBiceps) {
    const filtered = data.filter((x) => normName(x?.target ?? "").includes("biceps"));
    if (filtered.length > 0) data = filtered;
  }

  const picked = await pickBestWithImage(q, data);

  if (!picked?.ex) {
    return {
      ex: null,
      bestRes: null,
      dbg: { step: "name-scored-none", query: q, count: data.length, origCount },
    };
  }

  return {
    ex: picked.ex,
    bestRes: picked.bestRes,
    dbg: {
      step: "name-picked+bestRes",
      query: q,
      count: data.length,
      origCount,
      bestName: picked.ex.name,
      bestEquipment: picked.ex.equipment,
      bestTarget: picked.ex.target,
      bestId: picked.ex.id,
      bestRes: picked.bestRes,
    },
  };
}

/**
 * FULL LIST (paged)
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

  const MAX_PAGES = 20;

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

async function fetchByName(query: string) {
  const q = canonicalQuery(query);
  if (!q)
    return {
      ex: null as Exercise | null,
      bestRes: null as string | null,
      dbg: { step: "bad-query" },
    };

  const primary = await fetchByNameOnce(q);
  if (primary.ex) return primary;

  // ✅ specific rescues (these fix your exact plan names)
  if (q === "flat dumbbell press") {
    const alt = await fetchByNameOnce("dumbbell bench press");
    if (alt.ex) return { ex: alt.ex, bestRes: alt.bestRes, dbg: { step: "flat->db-bench" } };
  }
  if (q === "incline barbell bench press") {
    const alt = await fetchByNameOnce("incline bench press");
    if (alt.ex) return { ex: alt.ex, bestRes: alt.bestRes, dbg: { step: "incline-bb->incline-bench" } };
  }

  if (q === "push-up") {
    const male = await fetchByNameOnce("push-up (male)");
    if (male.ex) return { ex: male.ex, bestRes: male.bestRes, dbg: { step: "pushup-male-forced" } };

    const female = await fetchByNameOnce("push-up (female)");
    if (female.ex) return { ex: female.ex, bestRes: female.bestRes, dbg: { step: "pushup-female-forced" } };

    const bodyweight = await fetchByNameOnce("bodyweight push-up");
    if (bodyweight.ex)
      return { ex: bodyweight.ex, bestRes: bodyweight.bestRes, dbg: { step: "pushup-bodyweight" } };
  }

  if (q === "deadlift") {
    const dl = await fetchByNameOnce("barbell deadlift");
    if (dl.ex) return { ex: dl.ex, bestRes: dl.bestRes, dbg: { step: "deadlift-barbell" } };
  }

  const tryBarbell = await fetchByNameOnce(`barbell ${q}`);
  if (tryBarbell.ex)
    return { ex: tryBarbell.ex, bestRes: tryBarbell.bestRes, dbg: { step: "prefix-barbell", from: primary.dbg } };

  const tryDumbbell = await fetchByNameOnce(`dumbbell ${q}`);
  if (tryDumbbell.ex)
    return {
      ex: tryDumbbell.ex,
      bestRes: tryDumbbell.bestRes,
      dbg: { step: "prefix-dumbbell", from: primary.dbg },
    };

  const allRes = await fetchAllExercisesPaged();
  if (!allRes.list) {
    return { ex: null, bestRes: null, dbg: { step: "all-unavailable", primary: primary.dbg, all: allRes.dbg } };
  }

  const picked = await pickBestWithImage(q, allRes.list);
  if (!picked?.ex) {
    return { ex: null, bestRes: null, dbg: { step: "all-none", count: allRes.list.length, tried: q } };
  }

  return {
    ex: picked.ex,
    bestRes: picked.bestRes,
    dbg: {
      step: "all-picked+bestRes",
      count: allRes.list.length,
      tried: q,
      bestName: picked.ex.name,
      bestEquipment: picked.ex.equipment,
      bestTarget: picked.ex.target,
      bestId: picked.ex.id,
      bestRes: picked.bestRes,
    },
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

        const bestRes = r.bestRes ?? "180"; // fallback if unknown
        const imageUrl =
          `/api/exercises/image?exerciseId=${encodeURIComponent(ex.id)}` +
          `&resolution=${encodeURIComponent(bestRes)}`;

        const shaped = {
          id: ex.id,
          name: ex.name,
          bodyPart: ex.bodyPart,
          target: ex.target,
          equipment: ex.equipment,
          difficulty: ex.difficulty,
          category: ex.category,

          // ✅ now best quality
          bestRes,
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