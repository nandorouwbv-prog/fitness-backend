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

  // optional debug meta (harmless for app UI)
  __meta?: {
    fallback?: boolean;
    reason?: string;
    requestId?: string;
    model?: string;
    tookMs?: number;
    files?: string[];
  };
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

function makeRequestId(prefix = "pc") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

async function fileToDataUrl(file: File): Promise<string> {
  const ab = await file.arrayBuffer();
  const b64 = Buffer.from(ab).toString("base64");
  const mime = file.type || "image/jpeg";
  return `data:${mime};base64,${b64}`;
}

function fallbackData(language: "en" | "nl", reason = "fallback"): PhotoCompareResponse {
  return {
    summary: language === "nl" ? "Ik kon de foto’s niet betrouwbaar vergelijken." : "I couldn’t reliably compare the photos.",
    changes: [],
    notes: [
      language === "nl"
        ? "Probeer dezelfde hoek, afstand en verlichting te gebruiken."
        : "Try the same angle, distance, and lighting.",
      language === "nl"
        ? "Gebruik dezelfde pose (front relaxed / back relaxed) en zet de camera op borsthoogte."
        : "Use the same pose (front relaxed / back relaxed) and keep the camera at chest height.",
    ],
    confidence: "low",
    __meta: { fallback: true, reason },
  };
}

export async function POST(req: Request) {
  const started = Date.now();
  const requestId =
    safeStr(req.headers.get("x-request-id"), 80) ||
    safeStr(req.headers.get("x-vercel-id"), 80) ||
    makeRequestId("pc");

  // ✅ keep enough headroom on Vercel + OpenAI
  const TIMEOUT_MS = 28_000;

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      const out = fallbackData("en", "Missing OPENAI_API_KEY");
      out.__meta = { ...(out.__meta ?? {}), requestId, tookMs: Date.now() - started };
      return NextResponse.json({ ok: true, data: out }, { status: 200, headers: jsonHeaders() });
    }

    const form = await req.formData();

    const goal = safeStr(form.get("goal"), 40) || "general fitness";
    const languageRaw = safeStr(form.get("language"), 10).toLowerCase();
    const language: "en" | "nl" = languageRaw.startsWith("nl") ? "nl" : "en";

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
      const out = fallbackData(language, "No images provided");
      out.__meta = { ...(out.__meta ?? {}), requestId, tookMs: Date.now() - started };
      return NextResponse.json({ ok: true, data: out }, { status: 200, headers: jsonHeaders() });
    }

    // ✅ file size guard (prevents random serverless failures)
    // keep conservative: 2.5MB per file, 8MB total
    const MAX_PER_FILE = 2.5 * 1024 * 1024;
    const MAX_TOTAL = 8 * 1024 * 1024;

    const totalBytes = files.reduce((sum, x) => sum + (x.file.size || 0), 0);
    const tooBigOne = files.find((x) => (x.file.size || 0) > MAX_PER_FILE);

    if (tooBigOne || totalBytes > MAX_TOTAL) {
      const out = fallbackData(
        language,
        tooBigOne
          ? `File too large: ${tooBigOne.key}`
          : `Total upload too large: ${Math.round(totalBytes / 1024)}KB`
      );
      out.__meta = {
        ...(out.__meta ?? {}),
        requestId,
        tookMs: Date.now() - started,
        files: files.map((f) => `${f.key}:${Math.round((f.file.size || 0) / 1024)}KB`),
      };
      return NextResponse.json({ ok: true, data: out }, { status: 200, headers: jsonHeaders() });
    }

    const openai = new OpenAI({ apiKey });

    // ✅ must be vision-capable
    const model =
      process.env.OPENAI_VISION_MODEL ||
      process.env.OPENAI_COACH_MODEL ||
      "gpt-4o-mini";

    const dataUrls = await Promise.all(
      files.map(async (x) => ({ key: x.key, url: await fileToDataUrl(x.file) }))
    );

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

    const content: any[] = [
      {
        type: "text",
        text: `
Goal: ${goal}
RequestId: ${requestId}

Task:
- Compare "previous" vs "current" photos.
- If only current photos exist, provide a current assessment (no comparison).
- Focus on visible changes (waist tightness, shoulder/chest/back fullness, posture, symmetry, definition) WITHOUT overclaiming.
- If angles/lighting differ, lower confidence and say why.
- Make output feel personalized: mention 1-2 details tied to the images, but stay cautious.

Return JSON only.
`.trim(),
      },
    ];

    for (const x of dataUrls) {
      content.push({ type: "text", text: `Image: ${x.key}` });
      content.push({ type: "image_url", image_url: { url: x.url } });
    }

    const resp = await withTimeout(
      openai.chat.completions.create({
        model,
        temperature: 0.35,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content },
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

    if (!parsed || typeof parsed !== "object") {
      const out = fallbackData(language, "Invalid JSON from model");
      out.__meta = {
        ...(out.__meta ?? {}),
        requestId,
        model,
        tookMs: Date.now() - started,
      };
      return NextResponse.json({ ok: true, data: out }, { status: 200, headers: jsonHeaders() });
    }

    const out: PhotoCompareResponse = {
      summary:
        safeStr(parsed.summary, 260) ||
        (language === "nl" ? "Progress update." : "Progress update."),
      changes: Array.isArray(parsed.changes)
        ? parsed.changes.map((s: any) => safeStr(s, 140)).filter(Boolean).slice(0, 5)
        : [],
      notes: Array.isArray(parsed.notes)
        ? parsed.notes.map((s: any) => safeStr(s, 140)).filter(Boolean).slice(0, 5)
        : [],
      confidence:
        parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
          ? parsed.confidence
          : "medium",
      __meta: {
        fallback: false,
        requestId,
        model,
        tookMs: Date.now() - started,
        files: files.map((f) => `${f.key}:${Math.round((f.file.size || 0) / 1024)}KB`),
      },
    };

    return NextResponse.json({ ok: true, data: out }, { status: 200, headers: jsonHeaders() });
  } catch (e: any) {
    // Always return usable shape, so app never breaks
    const out = fallbackData("en", String(e?.message ?? "Unknown error"));
    out.__meta = {
      ...(out.__meta ?? {}),
      requestId,
      tookMs: Date.now() - started,
      reason: String(e?.message ?? "Unknown error"),
    };
    return NextResponse.json({ ok: true, data: out }, { status: 200, headers: jsonHeaders() });
  }
}