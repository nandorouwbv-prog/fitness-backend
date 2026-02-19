import { NextResponse } from "next/server";

/**
 * POST /api/exercises/alternatives
 * body: {
 *   name: string;            // current display name in app
 *   originalName?: string;   // optional original plan name
 *   reason: "equipment" | "difficulty" | "injury";
 *   injuryArea?: "shoulder" | "elbow" | "wrist" | "knee" | "hip" | "lower_back" | "other";
 *   debug?: boolean;
 * }
 *
 * returns: { ok: true, alternatives: [{ name, note? }] }
 */

type Exercise = {
  id: string;
  name: string;
  bodyPart?: string;
  target?: string;
  equipment?: string;
  secondaryMuscles?: string[];
  difficulty?: string;
  category?: string;
};

type AlternativeItem = { name: string; note?: string };

type CacheEntry = { value: any; expiresAt: number };

const g = globalThis as any;

// reuse the "all exercises" cache style (same as bulk)
g.__exerciseAllCache ??= null as null | { value: Exercise[]; expiresAt: number };
const ALL_TTL_MS = 1000 * 60 * 60 * 6; // 6h

// tiny cache for original lookup by name
g.__exerciseAltNameCache ??= new Map<string, CacheEntry>();
const nameCache: Map<string, CacheEntry> = g.__exerciseAltNameCache;

const TTL_MS = 1000 * 60 * 60 * 24; // 24h

function norm(s: any) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function safeText(v: any, fb = "") {
  if (v === null || v === undefined) return fb;
  return String(v);
}

function canonicalQuery(raw: string) {
  const q = norm(raw);
  const map: Record<string, string> = {
    "dumbbell bicep curl": "dumbbell curl",
    "dumbbell biceps curl": "dumbbell curl",
    "bicep curl": "dumbbell curl",
    "hammer curl": "dumbbell hammer curl",
    "push up": "push-up",
    pushup: "push-up",
    "push-ups": "push-up",
    "push ups": "push-up",
    deadlifts: "deadlift",
    "lat pulldown": "lat pulldown",
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

  return { ok: res.ok, status: res.status, json, text };
}

function scoreNameMatch(query: string, ex: Exercise) {
  const q = norm(query);
  const n = norm(ex?.name ?? "");
  if (!q || !n) return -1;
  if (q === n) return 999;

  const qt = q.split(" ").filter(Boolean);
  const nt = n.split(" ").filter(Boolean);

  let overlap = 0;
  for (const t of qt) if (nt.includes(t)) overlap++;

  let score = overlap * 10;
  if (n.includes(q)) score += 20;
  if (qt.length) score += Math.round((overlap / qt.length) * 12);

  // small equipment hints
  const equip = norm(ex?.equipment ?? "");
  if (qt.includes("dumbbell")) score += equip.includes("dumbbell") ? 18 : -10;
  if (qt.includes("barbell")) score += equip.includes("barbell") ? 18 : -10;
  if (qt.includes("cable")) score += equip.includes("cable") ? 16 : -8;
  if (qt.includes("machine")) score += equip.includes("machine") ? 16 : -8;

  return score;
}

async function findOriginalExerciseByName(name: string): Promise<Exercise | null> {
  const q = canonicalQuery(name);
  if (!q) return null;

  const cached = cacheGet(`orig:${q}`);
  if (cached !== undefined) return cached as Exercise | null;

  const url =
    `https://exercisedb.p.rapidapi.com/exercises/name/` +
    encodeURIComponent(q) +
    `?limit=10&offset=0`;

  const r = await fetchJson(url);

  if (!r.ok || !Array.isArray(r.json) || r.json.length === 0) {
    cacheSet(`orig:${q}`, null);
    return null;
  }

  const list = r.json as Exercise[];
  const picked = list
    .map((ex) => ({ ex, s: scoreNameMatch(q, ex) }))
    .sort((a, b) => b.s - a.s)[0];

  const best = picked?.s >= 6 ? picked.ex : null;
  cacheSet(`orig:${q}`, best);
  return best;
}

async function fetchAllExercisesPaged(): Promise<Exercise[] | null> {
  const now = Date.now();
  const cached = g.__exerciseAllCache as null | { value: Exercise[]; expiresAt: number };
  if (cached && now < cached.expiresAt) return cached.value;

  const limit = 200;
  let offset = 0;
  const all: Exercise[] = [];
  const MAX_PAGES = 20;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://exercisedb.p.rapidapi.com/exercises?limit=${limit}&offset=${offset}`;
    const r = await fetchJson(url);
    if (!r.ok || !Array.isArray(r.json)) return null;

    const batch = r.json as Exercise[];
    if (batch.length === 0) break;

    all.push(...batch);

    if (batch.length < limit) break;
    offset += limit;
  }

  if (all.length === 0) return null;

  g.__exerciseAllCache = { value: all, expiresAt: now + ALL_TTL_MS };
  return all;
}

function uniqByName(list: Exercise[]) {
  const seen = new Set<string>();
  const out: Exercise[] = [];
  for (const ex of list) {
    const k = norm(ex?.name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(ex);
  }
  return out;
}

function equipmentBucket(equipRaw?: string) {
  const e = norm(equipRaw ?? "");
  if (e.includes("barbell")) return "barbell";
  if (e.includes("dumbbell")) return "dumbbell";
  if (e.includes("cable")) return "cable";
  if (e.includes("machine") || e.includes("leverage")) return "machine";
  if (e.includes("band")) return "band";
  if (e.includes("body weight") || e.includes("bodyweight")) return "bodyweight";
  return e || "other";
}

function injuryExclusionKeywords(area: string) {
  // very pragmatic exclude lists
  const a = norm(area);
  if (a === "shoulder") return ["delts", "shoulders", "shoulder", "rotator", "pecs", "chest"];
  if (a === "elbow") return ["triceps", "biceps", "forearms", "elbow"];
  if (a === "wrist") return ["forearms", "wrist", "grip"];
  if (a === "knee") return ["quads", "quadriceps", "knee", "lunges", "squat"];
  if (a === "hip") return ["hip", "glutes"];
  if (a === "lower back") return ["lower back", "spine", "erector", "deadlift"];
  if (a === "lower_back") return ["lower back", "spine", "erector", "deadlift"];
  return [];
}

function matchGroup(original: Exercise, ex: Exercise) {
  const oTarget = norm(original?.target ?? "");
  const oBody = norm(original?.bodyPart ?? "");
  const t = norm(ex?.target ?? "");
  const b = norm(ex?.bodyPart ?? "");
  return (oTarget && t && oTarget === t) || (oBody && b && oBody === b);
}

function scoreAlt(
  originalName: string,
  ex: Exercise,
  reason: "equipment" | "difficulty" | "injury",
  original?: Exercise | null
) {
  const name = norm(ex?.name ?? "");
  const equip = equipmentBucket(ex?.equipment);
  const target = norm(ex?.target ?? "");
  const body = norm(ex?.bodyPart ?? "");

  // base: slight preference for same group when not injury
  let score = 0;
  if (reason !== "injury" && original) {
    if (norm(original.target) && target === norm(original.target)) score += 30;
    if (norm(original.bodyPart) && body === norm(original.bodyPart)) score += 18;
  }

  // avoid returning same exact
  if (norm(originalName) === name) score -= 999;

  // "easier" heuristic
  if (reason === "difficulty") {
    if (equip === "machine") score += 22;
    if (equip === "cable") score += 16;
    if (equip === "band") score += 14;
    if (equip === "bodyweight") score += 10;
    if (equip === "barbell") score -= 10;

    const n = name;
    if (n.includes("assisted")) score += 18;
    if (n.includes("kneeling")) score += 10;
    if (n.includes("incline")) score += 8;
  }

  // injury heuristic: prefer machine/cable and non-barbell; otherwise neutral
  if (reason === "injury") {
    if (equip === "machine") score += 20;
    if (equip === "cable") score += 14;
    if (equip === "band") score += 12;
    if (equip === "barbell") score -= 8;
  }

  // little randomness to avoid same 3 every time (stable-ish by hash)
  const hash = (() => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return Math.abs(h % 7);
  })();
  score += hash;

  return score;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;

    const reason = norm(body?.reason);
    const injuryAreaRaw = safeText(body?.injuryArea, "");
    const debug = Boolean(body?.debug);

    const inputName =
      safeText(body?.name, "") || safeText(body?.originalName, "");
    if (!inputName) {
      return NextResponse.json(
        { ok: false, error: "Missing name" },
        { status: 400 }
      );
    }

    if (!["equipment", "difficulty", "injury"].includes(reason)) {
      return NextResponse.json(
        { ok: false, error: "Invalid reason" },
        { status: 400 }
      );
    }

    // 1) find original (best effort)
    const original =
      (await findOriginalExerciseByName(inputName)) ??
      (body?.originalName ? await findOriginalExerciseByName(body.originalName) : null);

    // 2) get all list
    const all = await fetchAllExercisesPaged();
    if (!all) {
      return NextResponse.json(
        { ok: false, error: "Exercise list unavailable" },
        { status: 502 }
      );
    }

    const allUniq = uniqByName(all);

    // 3) build candidate set
    let candidates = allUniq;

    // If NOT injury: enforce same muscle group (target/bodyPart) as best as we can
    if (reason !== "injury" && original) {
      const sameGroup = candidates.filter((x) => matchGroup(original, x));
      if (sameGroup.length > 0) candidates = sameGroup;
    }

    // Equipment-specific: try to keep same group but DIFFERENT equipment bucket
    if (reason === "equipment" && original) {
      const origBucket = equipmentBucket(original.equipment);
      const filtered = candidates.filter((x) => equipmentBucket(x.equipment) !== origBucket);
      if (filtered.length > 0) candidates = filtered;
    }

    // Injury: avoid injury keywords in bodyPart/target/name, and allow any muscle group
    if (reason === "injury") {
      const exKeys = injuryExclusionKeywords(
        injuryAreaRaw === "lower_back" ? "lower back" : injuryAreaRaw
      );

      if (exKeys.length > 0) {
        const filtered = candidates.filter((x) => {
          const s = `${norm(x?.name)} ${norm(x?.target)} ${norm(x?.bodyPart)}`;
          return !exKeys.some((k) => s.includes(norm(k)));
        });
        if (filtered.length > 0) candidates = filtered;
      }

      // also: if we know original, prefer NOT same group (so you can still train something else)
      if (original) {
        const notSame = candidates.filter((x) => !matchGroup(original, x));
        if (notSame.length > 0) candidates = notSame;
      }
    }

    // 4) rank + pick top 3
    const ranked = candidates
      .map((ex) => ({
        ex,
        s: scoreAlt(inputName, ex, reason as any, original),
      }))
      .sort((a, b) => b.s - a.s);

    const picked: AlternativeItem[] = [];
    const usedBuckets = new Set<string>();

    for (const r of ranked) {
      if (picked.length >= 3) break;
      const nm = safeText(r.ex?.name, "").trim();
      if (!nm) continue;

      // prevent duplicates & add variety by equipment
      const b = equipmentBucket(r.ex?.equipment);
      const key = norm(nm);
      if (key === norm(inputName)) continue;

      // variety rule: avoid 3 same equipment if possible
      if (picked.length < 2 && usedBuckets.has(b)) {
        // allow later if needed
        continue;
      }

      picked.push({
        name: nm,
        note:
          picked.length === 0
            ? "Best match"
            : undefined,
      });
      usedBuckets.add(b);
    }

    // if variety skipped too much, fill remaining without variety constraint
    if (picked.length < 3) {
      const seen = new Set(picked.map((x) => norm(x.name)));
      for (const r of ranked) {
        if (picked.length >= 3) break;
        const nm = safeText(r.ex?.name, "").trim();
        const key = norm(nm);
        if (!nm || key === norm(inputName) || seen.has(key)) continue;
        picked.push({ name: nm });
        seen.add(key);
      }
    }

    // final fallback
    if (picked.length === 0) {
      return NextResponse.json(
        { ok: true, alternatives: [], debug: debug ? { reason, original } : undefined },
        { status: 200 }
      );
    }

    return NextResponse.json(
      debug
        ? {
            ok: true,
            alternatives: picked,
            debug: {
              reason,
              injuryArea: injuryAreaRaw || null,
              original: original
                ? {
                    name: original.name,
                    target: original.target,
                    bodyPart: original.bodyPart,
                    equipment: original.equipment,
                  }
                : null,
              poolSize: candidates.length,
            },
          }
        : { ok: true, alternatives: picked },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
