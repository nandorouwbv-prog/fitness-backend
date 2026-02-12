import OpenAI from "openai";
import { z } from "zod";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// ✅ If you're on Vercel: allows longer serverless execution (plan-dependent)
export const maxDuration = 120;

 // (just to keep TS happy if you edit later)

const Weekday = z.enum([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);

const InputSchema = z
  .object({
    goal: z.string(),
    experience: z.enum(["beginner", "intermediate", "advanced"]),
    daysPerWeek: z.number().min(1).max(7),
    trainingDays: z.array(Weekday).optional().default([]),
    equipment: z.array(z.string()).optional().default([]),
    injuries: z.string().optional().default(""),
    sessionMinutes: z.number().min(20).max(120).default(45),
  })
  .superRefine((val, ctx) => {
    if (val.trainingDays?.length) {
      const unique = Array.from(new Set(val.trainingDays));
      if (unique.length !== val.trainingDays.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "trainingDays contains duplicates",
          path: ["trainingDays"],
        });
      }
      if (val.trainingDays.length !== val.daysPerWeek) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "trainingDays length must match daysPerWeek (or omit trainingDays).",
          path: ["trainingDays"],
        });
      }
    }
  });

const DEFAULT_ORDER: Array<z.infer<typeof Weekday>> = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** -----------------------------
 * ✅ Simple in-memory cache (per server instance)
 * ---------------------------- */
type CacheEntry = { value: any; expiresAt: number };
const g = globalThis as any;
g.__planCache ??= new Map<string, CacheEntry>();
const planCache: Map<string, CacheEntry> = g.__planCache;

function stableKey(obj: any) {
  // stable stringify for caching
  const sortKeys = (x: any): any => {
    if (Array.isArray(x)) return x.map(sortKeys);
    if (x && typeof x === "object") {
      return Object.keys(x)
        .sort()
        .reduce((acc: any, k) => {
          acc[k] = sortKeys(x[k]);
          return acc;
        }, {});
    }
    return x;
  };
  return JSON.stringify(sortKeys(obj));
}

function getCache(key: string) {
  const hit = planCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    planCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCache(key: string, value: any, ttlMs: number) {
  planCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export async function POST(req: Request) {
  const t0 = Date.now();

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "Missing OPENAI_API_KEY" }, { status: 500 });
    }

    const body = await req.json();
    const input = InputSchema.parse(body);

    const trainingDays =
      input.trainingDays?.length > 0
        ? input.trainingDays
        : DEFAULT_ORDER.slice(0, input.daysPerWeek);

    const daysPerWeek = trainingDays.length;

    // ✅ Cache by normalized input
    const cacheKey = stableKey({
      goal: input.goal,
      experience: input.experience,
      daysPerWeek,
      trainingDays,
      equipment: input.equipment,
      injuries: input.injuries,
      sessionMinutes: input.sessionMinutes,
    });

    const cached = getCache(cacheKey);
    if (cached) {
      return NextResponse.json({ ok: true, plan: cached, cached: true, ms: Date.now() - t0 });
    }

    const openai = new OpenAI({ apiKey });

    // ✅ Much shorter prompt (same rules, fewer tokens)
    const userPrompt = [
      `Create a realistic 4-week training plan as JSON only (no markdown).`,
      ``,
      `Rules:`,
      `- Exactly ${daysPerWeek} sessions per week.`,
      `- Session.day MUST be one of: ${trainingDays.join(", ")} (use exactly these strings).`,
      `- Every week must include each day exactly once (no missing, no extra).`,
      `- Each session: { day, focus, exercises }`,
      `- exercises: 4..8 items`,
      `- each exercise: { name, sets(2..5), reps("8-12" or number), restSec(45..120) }`,
      ``,
      `User:`,
      `Goal: ${input.goal}`,
      `Experience: ${input.experience}`,
      `Training days: ${trainingDays.join(", ")}`,
      `Session length: ${input.sessionMinutes} min`,
      `Equipment: ${input.equipment.join(", ") || "none"}`,
      `Injuries: ${input.injuries || "none"}`,
      ``,
      `Output must match this exact shape:`,
      `{
  "goal": string,
  "experience": string,
  "days_per_week": number,
  "training_days": string[],
  "session_length_minutes": number,
  "plan": {
    "weeks": [
      {
        "week": 1,
        "sessions": [
          {
            "day": "Monday",
            "focus": "string",
            "exercises": [
              { "name": "string", "sets": 3, "reps": "8-12", "restSec": 60 }
            ]
          }
        ]
      }
    ]
  }
}`,
      ``,
      `Make weeks 2-4 slightly progressive but keep the same training_days structure.`,
    ].join("\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.35,
      response_format: { type: "json_object" },
      max_tokens: 2500, // ✅ prevents runaway / keeps it fast
      messages: [
        { role: "system", content: "Return valid JSON only. No markdown." },
        { role: "user", content: userPrompt },
      ],
    });

    const content = completion.choices[0]?.message?.content ?? "{}";

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Model returned invalid JSON", raw: content.slice(0, 500) },
        { status: 400 }
      );
    }

    // ✅ Hard safety checks
    const weeks = parsed?.plan?.weeks;
    if (!Array.isArray(weeks) || weeks.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Model output missing plan.weeks[]" },
        { status: 400 }
      );
    }

    for (const w of weeks) {
      const sessions = Array.isArray(w?.sessions) ? w.sessions : [];
      if (sessions.length !== daysPerWeek) {
        return NextResponse.json(
          {
            ok: false,
            error: `Model output invalid: week ${w?.week ?? "?"} has ${sessions.length} sessions, expected ${daysPerWeek}.`,
          },
          { status: 400 }
        );
      }

      const daySet = new Set(sessions.map((s: any) => String(s?.day ?? "")));
      for (const d of trainingDays) {
        if (!daySet.has(d)) {
          return NextResponse.json(
            { ok: false, error: `Model output invalid: week ${w?.week ?? "?"} missing day "${d}".` },
            { status: 400 }
          );
        }
      }
    }

    const plan = {
      goal: String(parsed?.goal ?? input.goal),
      experience: String(parsed?.experience ?? input.experience),
      days_per_week: daysPerWeek,
      training_days: trainingDays,
      session_length_minutes: input.sessionMinutes,
      plan: parsed?.plan,
    };

    // ✅ Cache for 6 hours (tune later)
    setCache(cacheKey, plan, 6 * 60 * 60 * 1000);

    return NextResponse.json({ ok: true, plan, cached: false, ms: Date.now() - t0 });
  } catch (error: any) {
    const message =
      error?.response?.data?.error?.message ||
      error?.message ||
      "Unknown error";

    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
