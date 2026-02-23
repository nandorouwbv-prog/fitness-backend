// app/api/photos/compare/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

type Confidence = "low" | "medium" | "high";

type PhotoCompareResponse = {
  summary: string;
  changes: string[];
  notes: string[];
  confidence: Confidence;
};

function jsonHeaders() {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  };
}

function safeStr(v: any, maxLen = 900) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

async function fileToDataUrl(file: File): Promise<string> {
  const ab = await file.arrayBuffer();
  const b64 = Buffer.from(ab).toString("base64");
  const mime = file.type || "image/jpeg";
  return `data:${mime};base64,${b64}`;
}

export async function POST(req: Request) {
  const started = Date.now();
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing OPENAI_API_KEY" },
        { status: 200, headers: jsonHeaders() }
      );
    }

    const form = await req.formData();

    // context fields
    const goal = safeStr(form.get("goal"), 40) || "general fitness";
    const languageRaw = safeStr(form.get("language"), 10).toLowerCase();
    const language = languageRaw.startsWith("nl") ? "nl" : "en";

    // images
    const prevFront = form.get("prevFront");
    const prevBack = form.get("prevBack");
    const currFront = form.get("currFront");
    const currBack = form.get("currBack");

    const files: { key: string; file: File }[] = [];
    if (prevFront instanceof File) files.push({ key: "prevFront", file: prevFront });
    if (prevBack instanceof File) files.push({ key: "prevBack", file: prevBack });
    if (currFront instanceof File) files.push({ key: "currFront", file: currFront });
    if (currBack instanceof File) files.push({ key: "currBack", file: currBack });

    if (files.length < 1) {
      return NextResponse.json(
        { ok: false, error: "No images provided" },
        { status: 200, headers: jsonHeaders() }
      );
    }

    const openai = new OpenAI({ apiKey });
    const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_COACH_MODEL || "gpt-4o-mini";

    // convert to data urls for OpenAI
    const dataUrls = await Promise.all(files.map(async (x) => ({ key: x.key, url: await fileToDataUrl(x.file) })));

    // Prompt: super strict -> no wild claims, mention confidence + lighting
    const system = `
You are a fitness progress photo reviewer inside a mobile app.
Return ONLY valid JSON (no markdown, no extra text).
Be careful: lighting/pose/angle changes can mislead. If not comparable, set confidence="low" and explain in notes.
Do NOT shame the user. Do not diagnose medical issues.

Output language: ${language === "nl" ? "Dutch" : "English"}.

JSON schema:
{
  "summary": string (1-2 sentences),
  "changes": string[] (2-5 bullets, concrete but cautious),
  "notes": string[] (2-5 bullets: how to take better comparable photos + next steps),
  "confidence": "low" | "medium" | "high"
}
`.trim();

    // We pass images with labels in the user content.
    const content: any[] = [
      {
        type: "text",
        text: `
Goal: ${goal}

Task:
- Compare "previous" vs "current" photos.
- If only current photos exist, provide a current assessment (no comparison).
- Focus on visible changes (waist tightness, shoulder/chest/back fullness, posture, symmetry, definition) WITHOUT overclaiming.
- If angles/lighting differ, lower confidence and say why.

Return JSON only.
`.trim(),
      },
    ];

    // Attach images with a short label so the model knows which is which
    for (const x of dataUrls) {
      content.push({ type: "text", text: `Image: ${x.key}` });
      content.push({ type: "image_url", image_url: { url: x.url } });
    }

    const resp = await openai.chat.completions.create({
      model,
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
    });

    const raw = resp.choices?.[0]?.message?.content ?? "";
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    if (!parsed || typeof parsed !== "object") {
      return NextResponse.json(
        {
          ok: true,
          data: {
            summary: language === "nl" ? "Ik kon de foto’s niet betrouwbaar vergelijken." : "I couldn’t reliably compare the photos.",
            changes: [],
            notes: [
              language === "nl"
                ? "Probeer dezelfde hoek, afstand en verlichting te gebruiken."
                : "Try the same angle, distance, and lighting.",
            ],
            confidence: "low",
          } satisfies PhotoCompareResponse,
          __meta: { tookMs: Date.now() - started, model },
        },
        { status: 200, headers: jsonHeaders() }
      );
    }

    const out: PhotoCompareResponse = {
      summary: safeStr(parsed.summary, 260) || (language === "nl" ? "Progress update." : "Progress update."),
      changes: Array.isArray(parsed.changes)
        ? parsed.changes.map((s: any) => safeStr(s, 140)).filter(Boolean).slice(0, 5)
        : [],
      notes: Array.isArray(parsed.notes)
        ? parsed.notes.map((s: any) => safeStr(s, 140)).filter(Boolean).slice(0, 5)
        : [],
      confidence: (parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low")
        ? parsed.confidence
        : "medium",
    };

    return NextResponse.json(
      { ok: true, data: out, __meta: { tookMs: Date.now() - started, model } },
      { status: 200, headers: jsonHeaders() }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? "Unknown error") },
      { status: 200, headers: jsonHeaders() }
    );
  }
}