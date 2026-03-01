// app/api/transform-gemini/route.ts
import { z } from "zod";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_DECODED_BYTES = 8 * 1024 * 1024; // ~8MB
const MAX_BASE64_LENGTH = Math.floor((MAX_DECODED_BYTES * 4) / 3);

const InputSchema = z.object({
  imageDataUrl: z.string().min(1),
  kg: z.union([z.literal(3), z.literal(6), z.literal(9)]),
  mode: z.enum(["safe", "shirtless"]).optional().default("safe"),
});

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
      }>;
    };
  }>;
};

function buildPrompt(kg: 3 | 6 | 9, mode: "safe" | "shirtless"): string {
  const intensity =
    kg === 3
      ? "Subtle increase in lean muscle mass. Slight improvement in chest, shoulders and arms."
      : kg === 6
        ? "Noticeable increase in lean muscle mass. Fuller chest, rounder shoulders, thicker arms, more visible abs."
        : "Strong but realistic increase in lean muscle mass. Significantly fuller chest, round deltoids, thicker arms, tighter waist, visible abdominal definition.";
  const base =
    "Realistic gym transformation of the same person. Preserve facial identity, face shape, and any tattoos. Preserve background, lighting, and pose. Non-sexual fitness context. Natural proportions, no exaggerated bodybuilder look. ";
  const clothing =
    mode === "safe"
      ? "Keep the person wearing a fitted athletic tank top. Show muscle gain through clothing."
      : "Male fitness progress photo, bare torso, keep shorts, non-sexual. No nude, erotic, or sexy context.";
  return `${base}${intensity} ${clothing}`;
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing GEMINI_API_KEY" },
        { status: 500 }
      );
    }

    const body = await req.json();
    const parsed = InputSchema.safeParse(body);

    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request body";
      return NextResponse.json(
        { error: msg, detail: parsed.error.issues?.[0]?.message },
        { status: 400 }
      );
    }

    const { imageDataUrl, kg, mode } = parsed.data;

    if (!imageDataUrl.startsWith("data:image/")) {
      return NextResponse.json(
        {
          error: "imageDataUrl must be a data URL starting with data:image/",
          detail: "Invalid imageDataUrl format",
        },
        { status: 400 }
      );
    }

    const base64Prefix = "base64,";
    const semicolon = imageDataUrl.indexOf(";");
    const mimeType =
      semicolon > 0
        ? imageDataUrl.slice(5, semicolon).trim() || "image/jpeg"
        : "image/jpeg";
    const base64Index = imageDataUrl.indexOf(base64Prefix);
    const base64Part =
      base64Index === -1 ? "" : imageDataUrl.slice(base64Index + base64Prefix.length);

    if (base64Part.length > MAX_BASE64_LENGTH) {
      return NextResponse.json(
        {
          error: `Image too large. Maximum decoded size is about ${MAX_DECODED_BYTES / 1024 / 1024}MB.`,
          detail: "Payload exceeds size limit",
        },
        { status: 400 }
      );
    }

    const prompt = buildPrompt(kg, mode);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${apiKey}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType,
                    data: base64Part,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["Text", "Image"],
            responseMimeType: "image/png",
          },
        }),
      });

      const data = (await res.json()) as GeminiGenerateResponse;
      const errorPayload = data as any;

      if (!res.ok) {
        const detail = errorPayload?.error?.message ?? "Gemini API error";
        return NextResponse.json(
          {
            error: "Image transformation failed",
            detail: typeof detail === "string" ? detail : String(detail),
          },
          { status: 500 }
        );
      }

      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      let b64: string | null = null;
      for (const part of parts) {
        if (part?.inlineData?.data) {
          b64 = part.inlineData.data;
          break;
        }
      }

      if (!b64) {
        return NextResponse.json(
          { error: "No image returned" },
          { status: 500 }
        );
      }

      return NextResponse.json({ b64 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        {
          error: "Image transformation failed",
          detail: message,
        },
        { status: 500 }
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Bad request";
    return NextResponse.json(
      { error: message, detail: err instanceof Error ? err.message : undefined },
      { status: 400 }
    );
  }
}
