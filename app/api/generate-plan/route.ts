import OpenAI from "openai";
import { z } from "zod";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const WeekdayEN = z.enum([
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
    trainingDays: z.array(WeekdayEN).optional().default([]), // ✅ NEW
    equipment: z.array(z.string()).optional().default([]),
    injuries: z.string().optional().default(""),
    sessionMinutes: z.number().min(20).max(120).default(45),
  })
  .superRefine((val, ctx) => {
    // If trainingDays provided, it must match daysPerWeek
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

// fallback: choose first N weekdays if trainingDays not supplied
const DEFAULT_ORDER: Array<z.infer<typeof WeekdayEN>> = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

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

    // We hard-enforce this server-side too
    const daysPerWeek = trainingDays.length;

    const prompt = `
You are a professional fitness coach.
Create a realistic 4-week training plan.

CRITICAL RULES (must follow exactly):
1) Return JSON ONLY (no markdown).
2) You MUST create exactly ${daysPerWeek} sessions PER WEEK.
3) The "day" field of each session MUST be exactly one of:
   ${JSON.stringify(trainingDays)}
4) Each week MUST contain one session for EACH of those training days (no missing days, no extra days).
5) Do NOT invent other day strings (like "Day 1"). Use the exact day names above.
6) Each session must include:
   - day: one of the allowed days
   - focus: short string (e.g. "Chest & Triceps")
   - exercises: 4 to 8 exercises
7) Each exercise must include:
   - name (simple common gym name)
   - sets (number 2-5)
   - reps (number or range string like "8-12")
   - restSec (number, typical 45-120)

User:
Goal: ${input.goal}
Experience: ${input.experience}
Training days: ${trainingDays.join(", ")}
Session length: ${input.sessionMinutes} minutes
Equipment: ${input.equipment.join(", ") || "none"}
Injuries: ${input.injuries || "none"}

OUTPUT SCHEMA (exact shape):
{
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
}

Make weeks 2-4 slightly progressive (small volume/intensity changes) but keep the same training_days structure.
Return valid JSON only.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return valid JSON only." },
        { role: "user", content: prompt },
      ],
    });

    const content = completion.choices[0].message.content ?? "{}";
    const parsed = JSON.parse(content);

    // ✅ Hard safety: if model forgot training_days or sessions mismatch, patch/fail fast.
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
            error: `Model output invalid: week ${w?.week ?? "?"} has ${
              sessions.length
            } sessions, expected ${daysPerWeek}.`,
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
              error: `Model output invalid: week ${
                w?.week ?? "?"
              } missing day "${d}".`,
            },
            { status: 400 }
          );
        }
      }
    }

    // normalize top fields (nice-to-have, keeps app consistent)
    const plan = {
      goal: String(parsed?.goal ?? input.goal),
      experience: String(parsed?.experience ?? input.experience),
      days_per_week: daysPerWeek,
      training_days: trainingDays,
      session_length_minutes: input.sessionMinutes,
      plan: parsed?.plan,
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
