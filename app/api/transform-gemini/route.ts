// app/api/transform-gemini/route.ts
import { z } from "zod";
import { NextResponse } from "next/server";
import path from "path";
import sharp from "sharp";
import * as ort from "onnxruntime-node";

export const runtime = "nodejs";

const MAX_DECODED_BYTES = 8 * 1024 * 1024; // ~8MB
const MAX_BASE64_LENGTH = Math.floor((MAX_DECODED_BYTES * 4) / 3);

const RETINA_INPUT_SIZE = 640;
const OVAL_MASK_FEATHER_PX = 25;

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

let retinaSession: ort.InferenceSession | null = null;

async function getRetinaSession(): Promise<ort.InferenceSession | null> {
  if (retinaSession) return retinaSession;
  try {
    const modelPath = path.join(process.cwd(), "models", "retinaface.onnx");
    const fs = await import("fs/promises");
    await fs.access(modelPath);
    retinaSession = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
    return retinaSession;
  } catch {
    return null;
  }
}

function buildPrompt(kg: 3 | 6 | 9, mode: "safe" | "shirtless"): string {
  const kgNote =
    kg === 9
      ? " For 9 kg, the muscle gain must be very noticeable and visually impactful, while remaining realistic."
      : "";
  const base =
    "This is a realistic male fitness progress transformation. " +
    "Edit the uploaded image of the SAME PERSON. Preserve the exact original facial identity. " +
    "CRITICAL: Do NOT modify facial structure. Do NOT change jawline or skull proportions. " +
    "Do NOT alter eye shape, eye distance, nose structure, or lip shape. Do NOT change age. " +
    "Only modify muscle mass below the neck. " +
    `Increase lean muscle mass by approximately ${kg} kg. ` +
    "Muscle growth should be clearly visible in: chest thickness, shoulder roundness, biceps and triceps size, upper back density, overall muscular fullness. " +
    "Keep the same: pose, background, lighting, camera angle, skin tone, tattoo placement. " +
    "Photorealistic. Natural anatomy. No exaggerated proportions." +
    kgNote;
  const clothing =
    mode === "safe"
      ? " Show the person wearing a fitted athletic tank top. Male fitness progress photo, non-sexual, professional gym lighting."
      : " Male fitness progress photo, bare torso, wearing shorts, non-sexual, professional gym lighting.";
  return base + clothing;
}

type FaceBox = { x: number; y: number; w: number; h: number };

function prepareRetinaInput(rgba: Buffer, w: number, h: number): Float32Array {
  const size = RETINA_INPUT_SIZE;
  const arr = new Float32Array(1 * 3 * size * size);
  const meanB = 104;
  const meanG = 117;
  const meanR = 123;
  const scale = Math.min(size / w, size / h);
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const padLeft = Math.floor((size - nw) / 2);
  const padTop = Math.floor((size - nh) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.min(w - 1, Math.max(0, Math.floor((x - padLeft) / scale)));
      const sy = Math.min(h - 1, Math.max(0, Math.floor((y - padTop) / scale)));
      const i = (sy * w + sx) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      arr[0 * size * size + y * size + x] = b - meanB;
      arr[1 * size * size + y * size + x] = g - meanG;
      arr[2 * size * size + y * size + x] = r - meanR;
    }
  }
  return arr;
}

function decodeRetinaOutput(
  outputs: ort.InferenceSession.OnnxValueMapType,
  imgW: number,
  imgH: number
): FaceBox | null {
  try {
    const names = Object.keys(outputs);
    let boxes: Float32Array | null = null;
    let scores: Float32Array | null = null;
    for (const n of names) {
      const t = outputs[n];
      if (!t || !("data" in t)) continue;
      const d = (t as ort.Tensor).data as Float32Array;
      const s = (t as ort.Tensor).dims;
      if (s.length === 3 && s[2] >= 4) boxes = d;
      if (s.length >= 2 && (s[1] === 2 || s[1] === 1)) scores = d;
    }
    if (!boxes) return null;
    const nDet = Math.floor(boxes.length / 4);
    let bestIdx = 0;
    let bestScore = 0.5;
    if (scores && scores.length >= nDet) {
      for (let i = 0; i < nDet; i++) {
        const sc = scores.length > nDet * 2 ? scores[i * 2 + 1] ?? scores[i] : scores[i];
        if (sc > bestScore) {
          bestScore = sc;
          bestIdx = i;
        }
      }
    }
    const scale = Math.min(RETINA_INPUT_SIZE / imgW, RETINA_INPUT_SIZE / imgH);
    const padLeft = Math.floor((RETINA_INPUT_SIZE - imgW * scale) / 2);
    const padTop = Math.floor((RETINA_INPUT_SIZE - imgH * scale) / 2);
    const x1 = (boxes[bestIdx * 4 + 0] - padLeft) / scale;
    const y1 = (boxes[bestIdx * 4 + 1] - padTop) / scale;
    const x2 = (boxes[bestIdx * 4 + 2] - padLeft) / scale;
    const y2 = (boxes[bestIdx * 4 + 3] - padTop) / scale;
    const x = Math.max(0, Math.floor(x1));
    const y = Math.max(0, Math.floor(y1));
    const w = Math.min(imgW - x, Math.max(1, Math.ceil(x2 - x1)));
    const h = Math.min(imgH - y, Math.max(1, Math.ceil(y2 - y1)));
    if (w < 16 || h < 16) return null;
    return { x, y, w, h };
  } catch {
    return null;
  }
}

async function detectFace(
  session: ort.InferenceSession,
  rgba: Buffer,
  w: number,
  h: number
): Promise<FaceBox | null> {
  const input = prepareRetinaInput(rgba, w, h);
  const inputName = session.inputNames[0];
  const feeds: Record<string, ort.Tensor> = {};
  feeds[inputName] = new ort.Tensor("float32", input, [
    1,
    3,
    RETINA_INPUT_SIZE,
    RETINA_INPUT_SIZE,
  ]);
  const out = await session.run(feeds);
  return decodeRetinaOutput(out, w, h);
}

function expandBox(box: FaceBox, imgW: number, imgH: number): FaceBox {
  const pad = 0.15;
  const dw = box.w * pad;
  const dh = box.h * pad;
  const x = Math.max(0, Math.floor(box.x - dw));
  const y = Math.max(0, Math.floor(box.y - dh));
  const x2 = Math.min(imgW, Math.ceil(box.x + box.w + dw));
  const y2 = Math.min(imgH, Math.ceil(box.y + box.h + dh));
  const w = Math.max(1, x2 - x);
  const h = Math.max(1, y2 - y);
  return { x, y, w, h };
}

function ovalMask(w: number, h: number, featherPx: number): Buffer {
  const buf = Buffer.alloc(w * h);
  const cx = w / 2;
  const cy = h / 2;
  const rx = (w * 0.85) / 2;
  const ry = (h * 0.9) / 2;
  const inner = 1 - featherPx / Math.max(rx, ry);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      const t =
        d >= 1 ? 0 : d <= inner ? 1 : Math.max(0, (1 - d) / (1 - inner));
      buf[y * w + x] = Math.round(255 * t);
    }
  }
  return buf;
}

async function faceLockComposite(
  generatedB64: string,
  base64Part: string
): Promise<string> {
  const originalBuf = Buffer.from(base64Part, "base64");
  const generatedBuf = Buffer.from(generatedB64, "base64");

  const session = await getRetinaSession();
  if (!session) return generatedB64;

  const origMeta = await sharp(originalBuf).metadata();
  const genMeta = await sharp(generatedBuf).metadata();
  const origW = origMeta.width ?? 0;
  const origH = origMeta.height ?? 0;
  const genW = genMeta.width ?? 0;
  const genH = genMeta.height ?? 0;
  if (origW < 32 || origH < 32 || genW < 32 || genH < 32) return generatedB64;

  const origRgba = await sharp(originalBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const genRgba = await sharp(generatedBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const boxOrig = await detectFace(session, origRgba.data, origW, origH);
  const boxGen = await detectFace(session, genRgba.data, genW, genH);
  if (!boxOrig || !boxGen) return generatedB64;

  const expanded = expandBox(boxOrig, origW, origH);

  const origPatch = await sharp(originalBuf)
    .extract({
      left: expanded.x,
      top: expanded.y,
      width: expanded.w,
      height: expanded.h,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const resized = await sharp(origPatch.data, {
    raw: {
      width: expanded.w,
      height: expanded.h,
      channels: 4,
    },
  })
    .resize(boxGen.w, boxGen.h, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const maskBuf = ovalMask(boxGen.w, boxGen.h, OVAL_MASK_FEATHER_PX);
  const overlayRgba = Buffer.alloc(boxGen.w * boxGen.h * 4);
  for (let i = 0; i < boxGen.w * boxGen.h; i++) {
    const a = maskBuf[i] / 255;
    overlayRgba[i * 4 + 0] = resized.data[i * 4 + 0];
    overlayRgba[i * 4 + 1] = resized.data[i * 4 + 1];
    overlayRgba[i * 4 + 2] = resized.data[i * 4 + 2];
    overlayRgba[i * 4 + 3] = Math.round(255 * a);
  }

  const overlayImg = await sharp(overlayRgba, {
    raw: { width: boxGen.w, height: boxGen.h, channels: 4 },
  })
    .png()
    .toBuffer();

  const composited = await sharp(generatedBuf)
    .composite([
      {
        input: overlayImg,
        left: boxGen.x,
        top: boxGen.y,
        blend: "over",
      },
    ])
    .png()
    .toBuffer();

  return composited.toString("base64");
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

      try {
        b64 = await faceLockComposite(b64, base64Part);
      } catch {
        // Face lock failed: return original generated image (no crash)
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
