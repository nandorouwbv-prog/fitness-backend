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
  const kgNote =
    kg === 9
      ? " For 9 kg, the muscle gain must be very noticeable and visually impactful, while remaining realistic."
      : "";
  return (
    "This is a realistic male fitness progress transformation. " +
    "Edit the uploaded image of the SAME PERSON. Preserve the exact original facial identity. " +
    "CRITICAL: Do NOT modify facial structure. Do NOT change jawline or skull proportions. " +
    "Do NOT alter eye shape, eye distance, nose structure, or lip shape. Do NOT change age. " +
    "Only modify muscle mass below the neck. " +
    `Increase lean muscle mass by approximately ${kg} kg. ` +
    "Muscle growth should be clearly visible in: chest thickness, shoulder roundness, biceps and triceps size, upper back density, overall muscular fullness. " +
    "Keep the same: pose, background, lighting, camera angle, skin tone, tattoo placement. " +
    "Male fitness progress photo, bare torso, wearing shorts, non-sexual, professional gym lighting. " +
    "Photorealistic. Natural anatomy. No exaggerated proportions." +
    kgNote
  );
}

function getStrength(kg: 3 | 6 | 9): number {
  if (kg === 3) return 0.45;
  if (kg === 6) return 0.55;
  return 0.65;
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
    const strength = getStrength(kg);

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
          strength,
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
