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
    corrected?: boolean;
    correctionReason?: string;
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

// ✅ tiny helper: detect "low energy/sleep" claims in summary
function looksLikeLowEnergySleep(summary: string) {
  const s = summary.toLowerCase();
  return (
    s.includes("low energy") ||
    s.includes("energy was low") ||
    s.includes("challenging with energy") ||
    s.includes("challenging with sleep") ||
    s.includes("sleep was low") ||
    s.includes("poor sleep") ||
    s.includes("tired") ||
    s.includes("fatigue")
  );
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

    const language = pickLanguage(context);

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
      // helps variation + debugging
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

    // ✅ data-locked system prompt
    const system = `
You are a premium strength coach inside a mobile app.

CRITICAL RULES (must follow):
- Use the numeric ratings exactly as truth. Do NOT claim low energy/sleep if ratings are high.
- If energy >= 4 AND sleep >= 4, you MUST describe the week as positive (not challenging).
- Only mention struggles if notesStruggle contains a real issue or ratings show it.
- Reference at least 1 concrete detail from notesGood or notesStruggle in the summary.
- Avoid generic clichés like "consistency is key" unless you tie it to a specific fact.
- Keep it short, direct, practical. No medical diagnosis. No illegal substances.

If sharp pain, numbness, dizziness, chest pain, or severe symptoms:
set safety.flag=true and advise to stop and seek professional help.

Return ONLY valid JSON (no markdown, no extra text).
Output language: ${language === "nl" ? "Dutch" : "English"}.

JSON schema:
{
  "summary": string (1-2 sentences),
  "wins": string[] (1-3),
  "focus": string[] (2-4),
  "actions_today": string[] (2-4),
  "next_workout_adjustment": { "type": "volume|intensity|exercise_swap|rest|deload|none", "details": string },
  "questions": string[] (0-2),
  "safety": { "flag": boolean, "message": string }
}
`.trim();

    // ✅ data-locked user prompt (explicit numbers)
    const user = `
WEEKLY CHECK-IN (TRUTH DATA):
- dateISO: ${payload.dateISO}
- weight: ${payload.weight ?? "N/A"}
- energy: ${payload.energy}/5
- sleep: ${payload.sleep}/5
- stress: ${payload.stress}/5
- notesGood: "${payload.notesGood}"
- notesStruggle: "${payload.notesStruggle}"
- hasFrontPhoto: ${payload.hasFrontPhoto}
- hasBackPhoto: ${payload.hasBackPhoto}

TODAY CONTEXT:
${JSON.stringify(ctx.today ?? {}, null, 2)}

PROFILE CONTEXT:
${JSON.stringify(
  {
    profileName: ctx.profileName,
    goal: ctx.goal,
    fitnessLevel: ctx.fitnessLevel,
    daysPerWeek: ctx.daysPerWeek,
    minutesPerSession: ctx.minutesPerSession,
    trainingSetup: ctx.trainingSetup,
  },
  null,
  2
)}

STRICT CHECKS:
- If energy >= 4 AND sleep >= 4: do NOT say the week was challenging; describe it positively.
- If notesStruggle is empty and ratings are high: do not invent problems.
- Mention energy/sleep/stress numbers in the summary OR in the first focus bullet.

TASK:
- summary: 1–2 sentences, must reference at least 1 detail from notesGood or notesStruggle.
- wins: 1–3 specific observations tied to the data.
- focus: 2–4 actionable priorities (not generic).
- actions_today: 2–4 concrete steps.
- next_workout_adjustment: ONE suggestion (or "none") and explain why using the data.
- questions: 0–2 only if truly needed.

Return JSON only.
`.trim();

    const resp = await withTimeout(
      openai.chat.completions.create({
        model: modelUsed,
        temperature: 0.85,
        presence_penalty: 0.55,
        frequency_penalty: 0.35,
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
    console.log("OPENAI RAW RESPONSE:");
    console.log(raw);

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

    let summary = safeStr(parsed.summary, 260) || fb.summary;

    // ✅ SANITY CORRECTION:
    // If user gave 5/5 and model still claims low energy/sleep -> correct it.
    let corrected = false;
    let correctionReason = "";

    if (payload.energy >= 4 && payload.sleep >= 4 && looksLikeLowEnergySleep(summary)) {
      corrected = true;
      correctionReason = "Model summary contradicted high energy/sleep ratings.";
      if (language === "nl") {
        summary = `Energie (${payload.energy}/5) en slaap (${payload.sleep}/5) zijn sterk — goede basis deze week. ${
          payload.notesGood ? `Top dat je aangeeft: ${safeStr(payload.notesGood, 120)}.` : ""
        }`.trim();
      } else {
        summary = `Energy (${payload.energy}/5) and sleep (${payload.sleep}/5) were strong — great base this week. ${
          payload.notesGood ? `You noted: ${safeStr(payload.notesGood, 120)}.` : ""
        }`.trim();
      }
    }

    const out: CoachAIResponse = {
      summary,
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
        corrected,
        correctionReason: corrected ? correctionReason : undefined,
      },
    };

    return NextResponse.json(out, { status: 200, headers: jsonHeaders() });
  } catch (e: any) {
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