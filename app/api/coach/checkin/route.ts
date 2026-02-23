// app/api/coach/checkin/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

type CoachAIResponse = {
  summary: string;
  wins: string[];
  focus: string[];
  actions_today: string[];
  next_workout_adjustment: {
    type: "volume" | "intensity" | "exercise_swap" | "rest" | "deload" | "none";
    details: string;
  };
  questions: string[];
  safety: { flag: boolean; message: string };

  // ✅ optional debug meta (harmless for the app UI)
  __meta?: {
    fallback?: boolean;
    reason?: string;
    requestId?: string;
    model?: string;
    tookMs?: number;
  };
};

function clampInt(v: any, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function safeStr(v: any, maxLen = 800) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function safeNum(v: any) {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
}

function pickLanguage(context: any): "en" | "nl" {
  const raw = String(context?.language ?? context?.lang ?? "").trim().toLowerCase();
  if (raw.startsWith("nl") || raw.includes("dutch") || raw.includes("neder")) return "nl";
  return "en";
}

function fallbackResponse(language: "en" | "nl" = "en"): CoachAIResponse {
  if (language === "nl") {
    return {
      summary:
        "Sterke check-in. Houd het simpel: consistent trainen, genoeg eiwit/water, en slaap strak houden.",
      wins: ["Je bent aan het tracken — dat is hoe je wint op lange termijn."],
      focus: [
        "Haal je geplande trainingen (of minimaal 2 als het druk is).",
        "Protein + hydration elke dag.",
        "Slaap: vaste bedtijd, schermen eerder uit.",
      ],
      actions_today: [
        "Doe je warm-up + je eerste oefening (minimale versie is ook goed).",
        "Log je sets en houd je rusttijden strak.",
      ],
      next_workout_adjustment: {
        type: "none",
        details: "Nog geen aanpassingen nodig — focus op consistentie.",
      },
      questions: ["Welke oefening voelt nu het meest ‘stuck’ en waarom denk je dat dat zo is?"],
      safety: { flag: false, message: "" },
    };
  }

  return {
    summary: "Strong check-in. Keep it simple: train consistently, hit protein + water, and lock in sleep.",
    wins: ["You’re tracking — that’s how you win long-term."],
    focus: [
      "Hit your planned sessions (or at least 2 if life is busy).",
      "Protein + hydration daily.",
      "Sleep: consistent bedtime, screens off earlier.",
    ],
    actions_today: [
      "Do your warm-up + your first exercise (minimum version still counts).",
      "Log your sets and keep rest times consistent.",
    ],
    next_workout_adjustment: {
      type: "none",
      details: "No adjustments yet — focus on consistency.",
    },
    questions: ["Which exercise feels most ‘stuck’ right now, and why do you think that is?"],
    safety: { flag: false, message: "" },
  };
}

function jsonHeaders() {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  };
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number, label = "timeout"): Promise<T> {
  let t: any;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

export async function POST(req: Request) {
  const started = Date.now();

  // ✅ This should be LONGER than typical model latency on Vercel
  const TIMEOUT_MS = 28_000;

  let requestId = "";
  let modelUsed = process.env.OPENAI_COACH_MODEL || "gpt-4o-mini";

  try {
    const body = await req.json();

    requestId = safeStr(body?.requestId, 80) || safeStr(req.headers.get("x-request-id"), 80) || "";

    const checkin = body?.checkin ?? {};
    const context = body?.context ?? {};

    const language = pickLanguage(context); // ✅ "en" default

    const payload = {
      dateISO: safeStr(checkin?.dateISO, 20),
      weight: safeNum(checkin?.weight),
      energy: clampInt(checkin?.energy, 1, 5, 3),
      sleep: clampInt(checkin?.sleep, 1, 5, 3),
      stress: clampInt(checkin?.stress, 1, 5, 3),
      notesGood: safeStr(checkin?.notesGood, 800),
      notesStruggle: safeStr(checkin?.notesStruggle, 800),
      hasFrontPhoto: !!checkin?.hasFrontPhoto,
      hasBackPhoto: !!checkin?.hasBackPhoto,
    };

    const ctx = {
      language,
      profileName: safeStr(context?.profileName, 60),
      goal: safeStr(context?.goal, 40),
      fitnessLevel: safeStr(context?.fitnessLevel, 40),
      daysPerWeek: Number(context?.daysPerWeek ?? 0) || null,
      minutesPerSession: Number(context?.minutesPerSession ?? 0) || null,
      trainingSetup: safeStr(context?.trainingSetup, 30),
      heightCm: Number(context?.heightCm ?? 0) || null,
      weightKg: Number(context?.weightKg ?? 0) || null,
      dietNotes: safeStr(context?.dietNotes, 400),
      stats: context?.stats ?? {},
      week: context?.week ?? {},
      today: context?.today ?? {},
      // ✅ helps variation + prevents “same wording”
      requestId,
      nowISO: new Date().toISOString(),
    };

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      const fb = fallbackResponse(language);
      fb.__meta = {
        fallback: true,
        reason: "Missing OPENAI_API_KEY",
        requestId,
        model: modelUsed,
        tookMs: Date.now() - started,
      };
      return NextResponse.json(fb, { status: 200, headers: jsonHeaders() });
    }

    const openai = new OpenAI({ apiKey });

    const system = `
You are a fitness coach inside a mobile app.
You MUST return ONLY valid JSON (no markdown, no extra text).
Be supportive, clear, and short. No medical diagnosis.
If the user mentions sharp pain, numbness, dizziness, chest pain, or severe symptoms:
set safety.flag=true and advise to stop and seek professional help.
Do not recommend illegal substances.

Important:
- Avoid repeating the same phrasing as prior check-ins.
- Use the user's notesGood/notesStruggle to personalize the output.
- Use different wording each time.

Output language: ${language === "nl" ? "Dutch" : "English"}.
JSON schema:
{
  "summary": string (1-2 sentences),
  "wins": string[] (1-3),
  "focus": string[] (2-4),
  "actions_today": string[] (2-4),
  "next_workout_adjustment": { "type": "...", "details": string },
  "questions": string[] (0-2),
  "safety": { "flag": boolean, "message": string }
}
`.trim();

    const user = `
WEEKLY CHECK-IN DATA:
${JSON.stringify(payload)}

CONTEXT:
${JSON.stringify(ctx)}

Task:
- Summarize the week in 1-2 sentences.
- Provide wins (1-3), focus (2-4), actions_today (2-4).
- Give ONE adjustment suggestion (or none). Keep it safe.
- Max 2 questions only if needed.
Language: ${language === "nl" ? "Dutch" : "English"}.
Return JSON only.
`.trim();

    // ✅ This call is what used to time out at 12s and fall back.
    const resp = await withTimeout(
      openai.chat.completions.create({
        model: modelUsed,
        temperature: 0.75,
        presence_penalty: 0.35,
        frequency_penalty: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      TIMEOUT_MS,
      "OpenAI timeout"
    );

    const raw = resp.choices?.[0]?.message?.content ?? "";
    let parsed: any = null;

    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    const fb = fallbackResponse(language);

    if (!parsed || typeof parsed !== "object") {
      fb.__meta = {
        fallback: true,
        reason: "Invalid JSON from model",
        requestId,
        model: modelUsed,
        tookMs: Date.now() - started,
      };
      return NextResponse.json(fb, { status: 200, headers: jsonHeaders() });
    }

    const out: CoachAIResponse = {
      summary: safeStr(parsed.summary, 260) || fb.summary,
      wins: Array.isArray(parsed.wins)
        ? parsed.wins.map((s: any) => safeStr(s, 120)).filter(Boolean).slice(0, 3)
        : fb.wins,
      focus: Array.isArray(parsed.focus)
        ? parsed.focus.map((s: any) => safeStr(s, 140)).filter(Boolean).slice(0, 4)
        : fb.focus,
      actions_today: Array.isArray(parsed.actions_today)
        ? parsed.actions_today.map((s: any) => safeStr(s, 140)).filter(Boolean).slice(0, 4)
        : fb.actions_today,
      next_workout_adjustment: {
        type: (parsed.next_workout_adjustment?.type as any) || "none",
        details: safeStr(parsed.next_workout_adjustment?.details, 180) || fb.next_workout_adjustment.details,
      },
      questions: Array.isArray(parsed.questions)
        ? parsed.questions.map((s: any) => safeStr(s, 120)).filter(Boolean).slice(0, 2)
        : fb.questions,
      safety: {
        flag: !!parsed.safety?.flag,
        message: safeStr(parsed.safety?.message, 220) || "",
      },
      __meta: {
        fallback: false,
        requestId,
        model: modelUsed,
        tookMs: Date.now() - started,
      },
    };

    return NextResponse.json(out, { status: 200, headers: jsonHeaders() });
  } catch (e: any) {
    // ✅ still return usable response, but now you can SEE it was fallback
    const fb = fallbackResponse("en");
    fb.__meta = {
      fallback: true,
      reason: String(e?.message ?? "Unknown error"),
      requestId,
      model: modelUsed,
      tookMs: Date.now() - started,
    };
    return NextResponse.json(fb, { status: 200, headers: jsonHeaders() });
  }
}