// app/api/transform/route.ts
import { z } from "zod";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_DECODED_BYTES = 8 * 1024 * 1024; // ~8MB
const MAX_BASE64_LENGTH = Math.floor((MAX_DECODED_BYTES * 4) / 3);

const InputSchema = z.object({
  imageDataUrl: z.string().min(1),
  kg: z.union([z.literal(3), z.literal(6), z.literal(9)]),
  allowShirtless: z.boolean().optional().default(false),
});

function buildPromptSafe(kg: 3 | 6 | 9): string {
  return (
    `Create a realistic fitness progress photo of the same person after consistent gym training. ` +
    `Same person identity, face unchanged and recognizable. ` +
    `Person wearing a VERY fitted athletic tank top (skin-tight, thin fabric). ` +
    `Strong gym lighting: hard key light, increased definition via shadows. ` +
    `Subtle sweat sheen on skin, non-sexual. ` +
    `Slightly closer crop on upper body (chest, shoulders, arms visible). ` +
    `Realistic, natural results—no extreme bodybuilder look. ` +
    `Keep background and pose similar to the original. ` +
    `No nudity, no erotic context, neutral expression, neutral pose. ` +
    `Add a subtle natural improvement in muscle definition and fullness (approximately ${kg} kg equivalent).`
  );
}

function buildPromptShirtless(kg: 3 | 6 | 9): string {
  return (
    `Create a realistic fitness progress photo of the same person after consistent gym training. ` +
    `Neutral fitness progress photo, non-sexual, no erotic context, no suggestive pose. ` +
    `Keep the face identical and recognizable. Shirtless gym progress pose is allowed. ` +
    `Maintain a similar pose, camera angle, lighting, and background. ` +
    `Add a subtle natural improvement in muscle definition and fullness (approximately ${kg} kg equivalent). ` +
    `Avoid exaggerated proportions. Keep it realistic.`
  );
}

function isModerationOrSafetyError(errBody: string): boolean {
  const lower = errBody.toLowerCase();
  return (
    lower.includes("moderation") ||
    lower.includes("content_policy") ||
    lower.includes("sexual") ||
    lower.includes("safety")
  );
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing OPENAI_API_KEY" },
        { status: 500 }
      );
    }

    const body = await req.json();
    const parsed = InputSchema.safeParse(body);

    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request body";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const { imageDataUrl, kg, allowShirtless } = parsed.data;

    if (!imageDataUrl.startsWith("data:image/")) {
      return NextResponse.json(
        { error: "imageDataUrl must be a data URL starting with data:image/" },
        { status: 400 }
      );
    }

    const base64Prefix = "base64,";
    const base64Index = imageDataUrl.indexOf(base64Prefix);
    const base64Part =
      base64Index === -1 ? "" : imageDataUrl.slice(base64Index + base64Prefix.length);

    if (base64Part.length > MAX_BASE64_LENGTH) {
      return NextResponse.json(
        {
          error: `Image too large. Maximum decoded size is about ${MAX_DECODED_BYTES / 1024 / 1024}MB.`,
        },
        { status: 400 }
      );
    }

    const prompt = allowShirtless ? buildPromptShirtless(kg) : buildPromptSafe(kg);

    const buffer = Buffer.from(base64Part, "base64");
    const formData = new FormData();
    formData.append("model", "gpt-image-1");
    formData.append("prompt", prompt);
    formData.append("image", new Blob([buffer], { type: "image/png" }), "input.png");

    try {
      let res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (!res.ok && allowShirtless) {
        const errBody = await res.text();
        if (isModerationOrSafetyError(errBody)) {
          const safeFormData = new FormData();
          safeFormData.append("model", "gpt-image-1");
          safeFormData.append("prompt", buildPromptSafe(kg));
          safeFormData.append("image", new Blob([buffer], { type: "image/png" }), "input.png");
          res = await fetch("https://api.openai.com/v1/images/edits", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            body: safeFormData,
          });
        } else {
          const lastError = new Error(errBody || `OpenAI API error: ${res.status}`);
          console.error("OpenAI response body:", errBody);
          console.error("Transform error:", lastError);
          return NextResponse.json(
            { error: "Image transformation failed", detail: String(lastError) },
            { status: 500 }
          );
        }
      }

      if (!res.ok) {
        const errBody = await res.text();
        const lastError = new Error(errBody || `OpenAI API error: ${res.status}`);
        console.error("OpenAI response body:", errBody);
        console.error("Transform error:", lastError);
        return NextResponse.json(
          { error: "Image transformation failed", detail: String(lastError) },
          { status: 500 }
        );
      }

      const data = (await res.json()) as {
        data?: Array<{ b64_json?: string }>;
      };

      const first = data?.data?.[0];
      const b64 = first?.b64_json;

      if (!b64 || typeof b64 !== "string") {
        const err = new Error("No b64_json in response");
        console.error("Transform error:", err);
        return NextResponse.json(
          { error: "Image transformation failed", detail: String(err) },
          { status: 500 }
        );
      }

      return NextResponse.json({ b64 });
    } catch (err) {
      console.error("Transform error:", err);
      return NextResponse.json(
        { error: "Image transformation failed", detail: String(err) },
        { status: 500 }
      );
    }
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? "Bad request" : "Bad request" },
      { status: 400 }
    );
  }
}
