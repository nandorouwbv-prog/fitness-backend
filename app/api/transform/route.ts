// app/api/transform/route.ts
import { z } from "zod";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const FAL_BASE = "https://queue.fal.run";
const FAL_MODEL = "fal-ai/flux/dev/image-to-image";

const MAX_DECODED_BYTES = 8 * 1024 * 1024; // ~8MB
const MAX_BASE64_LENGTH = Math.floor((MAX_DECODED_BYTES * 4) / 3);

const InputSchema = z.object({
  imageDataUrl: z.string().min(1),
  kg: z.union([z.literal(3), z.literal(6), z.literal(9)]),
  allowShirtless: z.boolean().optional().default(false),
});

function buildPrompt(kg: 3 | 6 | 9): string {
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

async function pollUntilCompleted(
  statusUrl: string,
  apiKey: string,
  maxAttempts = 60,
  intervalMs = 2000
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const statusRes = await fetch(statusUrl, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!statusRes.ok) {
      throw new Error(`Status check failed: ${statusRes.status}`);
    }
    const statusData = (await statusRes.json()) as { status?: string };
    if (statusData.status === "COMPLETED") return;
    if (statusData.status === "FAILED") {
      throw new Error("Fal queue job failed");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Fal queue timeout");
}

export async function POST(req: Request) {
  try {
    console.log("FAL_KEY exists?", !!process.env.FAL_KEY);
    const apiKey = process.env.FAL_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing FAL_KEY" },
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

    try {
      const submitRes = await fetch(`${FAL_BASE}/${FAL_MODEL}`, {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: imageDataUrl,
          prompt,
          strength: 0.4,
        }),
      });

      if (!submitRes.ok) {
        const errBody = await submitRes.text();
        console.error("Fal submit response body:", errBody);
        return NextResponse.json(
          { error: "Image transformation failed", detail: errBody },
          { status: 500 }
        );
      }

      const submitData = (await submitRes.json()) as {
        request_id?: string;
        response_url?: string;
        status_url?: string;
        images?: Array<{ url?: string }>;
      };

      let resultData: { images?: Array<{ url?: string }> };
      if (submitData.images && submitData.images.length > 0) {
        resultData = submitData;
      } else if (submitData.request_id && submitData.status_url) {
        await pollUntilCompleted(submitData.status_url, apiKey);
        const resultRes = await fetch(submitData.response_url!, {
          headers: { Authorization: `Key ${apiKey}` },
        });
        if (!resultRes.ok) {
          const errBody = await resultRes.text();
          console.error("Fal result response:", errBody);
          return NextResponse.json(
            { error: "Image transformation failed", detail: errBody },
            { status: 500 }
          );
        }
        resultData = (await resultRes.json()) as { images?: Array<{ url?: string }> };
      } else {
        return NextResponse.json(
          { error: "Image transformation failed", detail: "Unexpected fal response" },
          { status: 500 }
        );
      }

      const imageUrl = resultData.images?.[0]?.url;
      if (!imageUrl || typeof imageUrl !== "string") {
        return NextResponse.json(
          { error: "Image transformation failed", detail: "No image URL in result" },
          { status: 500 }
        );
      }

      const imageRes = await fetch(imageUrl);
      if (!imageRes.ok) {
        console.error("Fetch image failed:", imageRes.status);
        return NextResponse.json(
          { error: "Image transformation failed", detail: "Failed to fetch result image" },
          { status: 500 }
        );
      }
      const imageBytes = await imageRes.arrayBuffer();
      const b64 = Buffer.from(imageBytes).toString("base64");

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
