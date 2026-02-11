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

function fallbackResponse(): CoachAIResponse {
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

export async function POST(req: Request) {
  const ctrl = new AbortController();
  const timeoutMs = 12_000;
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const body = await req.json();

    const checkin = body?.checkin ?? {};
    const context = body?.context ?? {};

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
    };

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const system = `
Je bent een fitness coach in een mobiele app.
Je MOET alleen geldige JSON teruggeven (geen markdown, geen extra tekst).
Wees supportief, helder en kort. Geen medische diagnose.
Als de user scherpe pijn, gevoelloosheid, duizeligheid, pijn op de borst, of ernstige klachten noemt:
zet safety.flag=true en adviseer te stoppen en professionele hulp te zoeken.
Geen illegale middelen aanbevelen.
Output taal: Nederlands.
JSON schema:
{
  "summary": string (1-2 zinnen),
  "wins": string[] (1-3),
  "focus": string[] (2-4),
  "actions_today": string[] (2-4),
  "next_workout_adjustment": { "type": "...", "details": string },
  "questions": string[] (0-2),
  "safety": { "flag": boolean, "message": string }
}
`;

    const user = `
WEEKLY CHECK-IN DATA:
${JSON.stringify(payload)}

CONTEXT:
${JSON.stringify(ctx)}

Taak:
- Vat de week samen in 1-2 zinnen.
- Geef wins (1-3), focus (2-4), actions_today (2-4).
- Geef 1 adjustment suggestie (of none). Houd het veilig.
- Max 2 vragen alleen als nodig.
Return JSON only.
`;

    const model = process.env.OPENAI_COACH_MODEL || "gpt-4o-mini";

    const resp = await openai.chat.completions.create(
      {
        model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system.trim() },
          { role: "user", content: user.trim() },
        ],
      },
      { signal: ctrl.signal as any }
    );

    const raw = resp.choices?.[0]?.message?.content ?? "";
    let parsed: CoachAIResponse | null = null;

    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (!parsed || typeof parsed !== "object") {
      return NextResponse.json(fallbackResponse());
    }

    const out: CoachAIResponse = {
      summary: safeStr(parsed.summary, 260) || fallbackResponse().summary,
      wins: Array.isArray(parsed.wins) ? parsed.wins.map((s) => safeStr(s, 120)).filter(Boolean).slice(0, 3) : [],
      focus: Array.isArray(parsed.focus) ? parsed.focus.map((s) => safeStr(s, 140)).filter(Boolean).slice(0, 4) : [],
      actions_today: Array.isArray(parsed.actions_today)
        ? parsed.actions_today.map((s) => safeStr(s, 140)).filter(Boolean).slice(0, 4)
        : [],
      next_workout_adjustment: {
        type: (parsed.next_workout_adjustment?.type as any) || "none",
        details:
          safeStr(parsed.next_workout_adjustment?.details, 180) ||
          "Nog geen aanpassingen nodig — focus op consistentie.",
      },
      questions: Array.isArray(parsed.questions)
        ? parsed.questions.map((s) => safeStr(s, 120)).filter(Boolean).slice(0, 2)
        : [],
      safety: {
        flag: !!parsed.safety?.flag,
        message: safeStr(parsed.safety?.message, 220) || "",
      },
    };

    return NextResponse.json(out);
  } catch (e: any) {
    // Always return a usable response (no hard fail)
    return NextResponse.json(fallbackResponse(), { status: 200 });
  } finally {
    clearTimeout(t);
  }
}
