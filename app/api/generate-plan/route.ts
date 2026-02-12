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

function buildPrompt(input: z.infer<typeof InputSchema>, trainingDays: string[], daysPerWeek: number) {
  return `
You are a professional fitness coach.
Return JSON ONLY. No markdown. No extra text.

Create a realistic 4-week training plan.

Hard rules:
- Exactly ${daysPerWeek} sessions per week.
- Each session.day MUST be exactly one of: ${trainingDays.join(", ")}
- Each week must include each of those training days exactly once.
- Each session: day, focus, exercises (4-8 items)
- Each exercise: name, sets (2-5), reps ("8-12" or number), restSec (45-120)

User:
Goal: ${input.goal}
Experience: ${input.experience}
Training days: ${trainingDays.join(", ")}
Session length: ${input.sessionMinutes} minutes
Equipment: ${input.equipment.join(", ") || "none"}
Injuries: ${input.injuries || "none"}

Output must match this exact shape:
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
Weeks 2-4 should be slightly progressive.
`.trim();
}

async function createPlanJson(openai: OpenAI, prompt: string, temperature: number) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature,
    // keep outputs bounded
    max_tokens: 1800,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return valid JSON only. No markdown. No extra text." },
      { role: "user", content: prompt },
    ],
  });

  const content = completion.choices[0]?.message?.content ?? "";
  // If OpenAI ever returns empty/null (rare) -> fail fast
  if (!content || !content.trim()) {
    throw new Error("Empty JSON response from model");
  }

  // JSON.parse can still fail if the model violated constraints (OpenAI sometimes throws earlier too)
  return JSON.parse(content);
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "Missing OPENAI_API_KEY" }, { status: 500 });
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

    // ✅ Retry plan: if OpenAI complains about invalid JSON, retry with lower temp
    let parsed: any = null;
    const attempts = [
      { t: 0.4 },
      { t: 0.0 },
    ];

    let lastErr: any = null;

    for (const a of attempts) {
      try {
        parsed = await createPlanJson(openai, prompt, a.t);
        lastErr = null;
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? "");
        lastErr = e;

        // If it's NOT a JSON-format issue, stop retrying
        const jsonish =
          msg.toLowerCase().includes("invalid json") ||
          msg.toLowerCase().includes("model returned invalid json") ||
          msg.toLowerCase().includes("json") ||
          msg.toLowerCase().includes("parse");

        if (!jsonish) break;
      }
    }

    if (!parsed) {
      const message =
        lastErr?.response?.data?.error?.message ||
        lastErr?.message ||
        "Unknown error";
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }

    // --- Validate output shape a bit
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
            {
              ok: false,
              error: `Model output invalid: week ${w?.week ?? "?"} missing day "${d}".`,
            },
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

    return NextResponse.json({ ok: true, plan });
  } catch (error: any) {
    const message =
      error?.response?.data?.error?.message ||
      error?.message ||
      "Unknown error";

    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
