// app/api/transform/route.ts
import { z } from "zod";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_DECODED_BYTES = 8 * 1024 * 1024; // ~8MB
const MAX_BASE64_LENGTH = Math.floor((MAX_DECODED_BYTES * 4) / 3);

const InputSchema = z.object({
  imageDataUrl: z.string().min(1),
  kg: z.union([z.literal(3), z.literal(6), z.literal(9)]),
});

function buildPrompt(kg: 3 | 6 | 9): string {
  return (
    `Enhance this photo to show the same person after consistent gym training. ` +
    `Add a subtle, natural increase in lean muscle tone (approximately ${kg} kg equivalent). ` +
    `Keep the face identical. ` +
    `Maintain the same lighting, pose, and background. ` +
    `Avoid exaggerated or bodybuilder proportions. ` +
    `Make it realistic and believable.`
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

    const { imageDataUrl, kg } = parsed.data;

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

    const prompt = buildPrompt(kg);
    const models: ("gpt-image-1.5" | "gpt-image-1")[] = ["gpt-image-1.5", "gpt-image-1"];

    let lastError: unknown = null;

    for (const model of models) {
      try {
        const res = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            images: [{ image_url: imageDataUrl }],
            prompt,
            input_fidelity: "high",
            n: 1,
            output_format: "png",
          }),
        });

        if (!res.ok) {
          const errBody = await res.text();
          lastError = new Error(errBody || `OpenAI API error: ${res.status}`);
          console.error("OpenAI response body:", errBody);
          console.error("Transform error:", lastError);
          if (model === "gpt-image-1.5" && res.status >= 400) {
            continue;
          }
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
        lastError = err;
        console.error("Transform error:", err);
        if (model === "gpt-image-1.5") continue;
        return NextResponse.json(
          { error: "Image transformation failed", detail: String(err) },
          { status: 500 }
        );
      }
    }

    console.error("Transform error:", lastError);
    return NextResponse.json(
      { error: "Image transformation failed", detail: String(lastError ?? "Unknown") },
      { status: 500 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? "Bad request" : "Bad request" },
      { status: 400 }
    );
  }
}
