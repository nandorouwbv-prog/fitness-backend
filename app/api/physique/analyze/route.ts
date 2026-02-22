// app/api/physique/analyze/route.ts
import OpenAI from "openai";
import { z } from "zod";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const InputSchema = z.object({
  // ✅ stuur "data:image/jpeg;base64,...." (of png)
  frontImageDataUrl: z.string().min(20),
  backImageDataUrl: z.string().min(20).optional().default(""),
  // optional context
  goal: z.string().optional().default("Build muscle"),
  experience: z.enum(["beginner", "intermediate", "advanced"]).optional().default("beginner"),
});

function safeStr(v: any) {
  return String(v ?? "").trim();
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

    const front = safeStr(input.frontImageDataUrl);
    const back = safeStr(input.backImageDataUrl);

    const system = `
You are a fitness coach doing a physique assessment.
Return STRICT JSON only. No markdown, no extra text.
Be careful: you cannot know exact body fat %, but you can give rough ranges and visual observations.
If something is unclear, say "uncertain".
`.trim();

    const user = `
Analyze these photos for training plan personalization.

Goal: ${input.goal}
Experience: ${input.experience}

Return JSON with:
{
  "summary": string,
  "strengths": string[],
  "weaknesses": string[],
  "focusAreas": string[],        // e.g. "upper chest", "lats width", "rear delts", "quads"
  "symmetryNotes": string[],
  "estimatedBodyfatRange": string, // e.g. "12-16%" or "uncertain"
  "trainingBias": {
    "style": "hypertrophy" | "strength" | "mixed",
    "volume": "low" | "medium" | "high",
    "notes": string
  },
  "exercisePreferences": {
    "emphasis": string[],        // e.g. "machines", "free weights", "unilateral"
    "avoid": string[]            // e.g. "too much plyometrics" (if fitness-only)
  }
}
`.trim();

    const contentParts: any[] = [
      { type: "text", text: user },
      {
        type: "image_url",
        image_url: { url: front },
      },
    ];

    if (back) {
      contentParts.push({
        type: "image_url",
        image_url: { url: back },
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // ✅ vision-capable :contentReference[oaicite:1]{index=1}
      temperature: 0.2,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: contentParts as any },
      ],
    });

    const txt = completion.choices?.[0]?.message?.content ?? "{}";

    let parsed: any = {};
    try {
      parsed = JSON.parse(txt);
    } catch {
      // fallback: keep it stable
      parsed = { summary: "uncertain", strengths: [], weaknesses: [], focusAreas: [] };
    }

    return NextResponse.json({ ok: true, analysis: parsed });
  } catch (error: any) {
    const message =
      error?.response?.data?.error?.message || error?.message || "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}