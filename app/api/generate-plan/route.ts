import OpenAI from "openai";
import { z } from "zod";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

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
          message:
            "trainingDays length must match daysPerWeek (or omit trainingDays).",
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

function buildPrompt(
  input: z.infer<typeof InputSchema>,
  trainingDays: string[],
  daysPerWeek: number
) {
  return `
You are a professional fitness coach.
Create a realistic 4-week training plan.

Hard rules:
- Exactly ${daysPerWeek} sessions per week.
- Each session.day MUST be exactly one of: ${trainingDays.join(", ")}
- Each week must include each of those training days exactly once.
- Each session has: day, focus, exercises (4-8)
- Each exercise has: name, sets (2-5), reps ("8-12" or number), restSec (45-120)

User:
Goal: ${input.goal}
Experience: ${input.experience}
Training days: ${trainingDays.join(", ")}
Session length: ${input.sessionMinutes} minutes
Equipment: ${input.equipment.join(", ") || "none"}
Injuries: ${input.injuries || "none"}

Return ONLY via the function tool call.
`.trim();
}

/** ✅ NEW: repair invalid JSON from tool arguments */
async function repairJsonWithModel(openai: OpenAI, broken: string) {
  const fix = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You fix invalid JSON. Return valid JSON ONLY. Do not add comments or markdown.",
      },
      {
        role: "user",
        content: `Fix this invalid JSON and return the corrected JSON only:\n\n${broken}`,
      },
    ],
  });

  const content = fix.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(content);
}

/** ✅ UPDATED: tolerate invalid JSON tool arguments */
async function runToolPlan(
  openai: OpenAI,
  prompt: string,
  temperature: number
): Promise<any> {
  const toolName = "create_training_plan";

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature,
    max_tokens: 2200,
    messages: [
      {
        role: "system",
        content: "Use the tool to return structured output. No extra text.",
      },
      { role: "user", content: prompt },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: toolName,
          description: "Return a 4-week training plan in a strict JSON structure.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              goal: { type: "string" },
              experience: { type: "string" },
              days_per_week: { type: "number" },
              training_days: { type: "array", items: { type: "string" } },
              session_length_minutes: { type: "number" },
              plan: {
                type: "object",
                additionalProperties: false,
                properties: {
                  weeks: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        week: { type: "number" },
                        sessions: {
                          type: "array",
                          items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                              day: { type: "string" },
                              focus: { type: "string" },
                              exercises: {
                                type: "array",
                                items: {
                                  type: "object",
                                  additionalProperties: false,
                                  properties: {
                                    name: { type: "string" },
                                    sets: { type: "number" },
                                    reps: { type: "string" },
                                    restSec: { type: "number" },
                                  },
                                  required: ["name", "sets", "reps", "restSec"],
                                },
                              },
                            },
                            required: ["day", "focus", "exercises"],
                          },
                        },
                      },
                      required: ["week", "sessions"],
                    },
                  },
                },
                required: ["weeks"],
              },
            },
            required: [
              "goal",
              "experience",
              "days_per_week",
              "training_days",
              "session_length_minutes",
              "plan",
            ],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: toolName } },
  });

  const msg = completion.choices?.[0]?.message as any;
  const toolCalls = msg?.tool_calls ?? [];
  const argsStr = toolCalls?.[0]?.function?.arguments;

  if (!argsStr || typeof argsStr !== "string") {
    throw new Error("Model did not return tool arguments.");
  }

  try {
    return JSON.parse(argsStr);
  } catch {
    return await repairJsonWithModel(openai, argsStr);
  }
}

/** -----------------------------
 *  ✅ NEW: Auto-repair weeks (prevents crashes)
 *  ---------------------------- */

function clamp(n: any, min: number, max: number) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function safeStr(v: any) {
  return String(v ?? "").trim();
}

function makeFallbackExercises(goal: string) {
  // simple, safe defaults (4 exercises)
  const g = safeStr(goal).toLowerCase();
  const isFat = g.includes("fat") || g.includes("cut") || g.includes("lose");
  const reps = isFat ? "12-15" : "8-12";

  return [
    { name: "Incline Dumbbell Press", sets: 3, reps, restSec: 75 },
    { name: "Lat Pulldown", sets: 3, reps, restSec: 75 },
    { name: "Leg Press", sets: 3, reps, restSec: 90 },
    { name: "Plank", sets: 3, reps: "30-45 sec", restSec: 60 },
  ];
}

function makeFallbackSession(day: string, goal: string, label = "Recovery / Accessory") {
  return {
    day,
    focus: label,
    exercises: makeFallbackExercises(goal),
  };
}

function coerceToTrainingDay(rawDay: any, trainingDays: string[]): string | null {
  const d = safeStr(rawDay);
  if (!d) return null;

  // exact match
  if (trainingDays.includes(d)) return d;

  // case-insensitive match
  const lower = d.toLowerCase();
  const ci = trainingDays.find((x) => x.toLowerCase() === lower);
  if (ci) return ci;

  // common short forms
  const short = lower.slice(0, 3);
  const map: Record<string, string> = {
    mon: "Monday",
    tue: "Tuesday",
    wed: "Wednesday",
    thu: "Thursday",
    fri: "Friday",
    sat: "Saturday",
    sun: "Sunday",
  };
  const full = map[short];
  if (full && trainingDays.includes(full)) return full;

  return null;
}

function repairWeekSessions(args: {
  weekObj: any;
  trainingDays: string[];
  daysPerWeek: number;
  goal: string;
}) {
  const { weekObj, trainingDays, daysPerWeek, goal } = args;

  const rawSessions = Array.isArray(weekObj?.sessions) ? weekObj.sessions : [];

  // 1) normalize day -> must be one of trainingDays (or null)
  const normalized = rawSessions
    .map((s: any) => {
      const fixedDay = coerceToTrainingDay(s?.day, trainingDays);
      const exercises = Array.isArray(s?.exercises) ? s.exercises : [];
      const hasEnough = exercises.length >= 1;

      // keep if we can place it on a training day
      if (!fixedDay) return null;

      return {
        ...s,
        day: fixedDay,
        focus: safeStr(s?.focus) || "Training",
        exercises: hasEnough ? exercises : makeFallbackExercises(goal),
      };
    })
    .filter(Boolean) as any[];

  // 2) ensure unique day per week (keep first occurrence)
  const seen = new Set<string>();
  const uniqueByDay: any[] = [];
  for (const s of normalized) {
    const d = safeStr(s.day);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    uniqueByDay.push(s);
  }

  // 3) fill missing trainingDays with fallback sessions
  const missing = trainingDays.filter((d) => !seen.has(d));
  for (const d of missing) {
    uniqueByDay.push(makeFallbackSession(d, goal, "Recovery / Accessory"));
  }

  // 4) sort sessions to match trainingDays order
  uniqueByDay.sort(
    (a, b) => trainingDays.indexOf(a.day) - trainingDays.indexOf(b.day)
  );

  // 5) enforce exact length (trim if too many)
  const finalSessions = uniqueByDay.slice(0, daysPerWeek);

  return {
    ...weekObj,
    sessions: finalSessions,
  };
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing OPENAI_API_KEY" },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey });

    const body = await req.json();
    const input = InputSchema.parse(body);

    const trainingDays =
      input.trainingDays?.length > 0
        ? input.trainingDays
        : DEFAULT_ORDER.slice(0, input.daysPerWeek);

    const daysPerWeek = trainingDays.length;
    const prompt = buildPrompt(input, trainingDays, daysPerWeek);

    // ✅ retry with lower temp if something weird happens
    let parsed: any = null;
    let lastErr: any = null;

    for (const t of [0.4, 0.0]) {
      try {
        parsed = await runToolPlan(openai, prompt, t);
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = e;
      }
    }

    if (!parsed) {
      const message =
        lastErr?.response?.data?.error?.message ||
        lastErr?.message ||
        "Unknown error";
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }

    // ✅ weeks exist?
    const weeks = parsed?.plan?.weeks;
    if (!Array.isArray(weeks) || weeks.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Model output missing plan.weeks[]" },
        { status: 400 }
      );
    }

    // ✅ NEW: repair instead of hard-fail
    const repairedWeeks = weeks.map((w: any) =>
      repairWeekSessions({
        weekObj: w,
        trainingDays,
        daysPerWeek,
        goal: parsed?.goal ?? input.goal,
      })
    );

    // (Optional) still sanity-check after repair
    for (const w of repairedWeeks) {
      const sessions = Array.isArray(w?.sessions) ? w.sessions : [];
      if (sessions.length !== daysPerWeek) {
        return NextResponse.json(
          {
            ok: false,
            error: `Repair failed: week ${w?.week ?? "?"} has ${sessions.length} sessions, expected ${daysPerWeek}.`,
          },
          { status: 400 }
        );
      }

      const daySet = new Set(sessions.map((s: any) => String(s?.day ?? "")));
      for (const d of trainingDays) {
        if (!daySet.has(d)) {
          return NextResponse.json(
            {
              ok: false,
              error: `Repair failed: week ${w?.week ?? "?"} missing day "${d}".`,
            },
            { status: 400 }
          );
        }
      }
    }

    // ✅ normalize top fields (keep consistent)
    const plan = {
      goal: String(parsed?.goal ?? input.goal),
      experience: String(parsed?.experience ?? input.experience),
      days_per_week: daysPerWeek,
      training_days: trainingDays,
      session_length_minutes: input.sessionMinutes,
      plan: {
        ...(parsed?.plan ?? {}),
        weeks: repairedWeeks,
      },
    };

    return NextResponse.json({ ok: true, plan });
  } catch (error: any) {
    const message =
      error?.response?.data?.error?.message ||
      error?.message ||
      "Unknown error";

    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
