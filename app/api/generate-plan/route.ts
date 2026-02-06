import OpenAI from "openai";
import { z } from "zod";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const InputSchema = z.object({
  goal: z.string(),
  experience: z.enum(["beginner", "intermediate", "advanced"]),
  daysPerWeek: z.number().min(1).max(7),
  equipment: z.array(z.string()).optional().default([]),
  injuries: z.string().optional().default(""),
  sessionMinutes: z.number().min(20).max(120).default(45),
});

export async function POST(req: Request) {
  try {
const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing OPENAI_API_KEY" },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey });

    const body = await req.json();
    const input = InputSchema.parse(body);

    const prompt = `
You are a professional fitness coach.
Create a realistic 4-week training plan in JSON only.

User:
Goal: ${input.goal}
Experience: ${input.experience}
Days/week: ${input.daysPerWeek}
Session length: ${input.sessionMinutes} minutes
Equipment: ${input.equipment.join(", ") || "none"}
Injuries: ${input.injuries || "none"}

Return JSON only.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return valid JSON only." },
        { role: "user", content: prompt },
      ],
    });

    const content = completion.choices[0].message.content ?? "{}";
    const plan = JSON.parse(content);

    return NextResponse.json({ ok: true, plan });
  } catch (error: any) {
    const message =
      error?.response?.data?.error?.message ||
      error?.message ||
      "Unknown error";

    return NextResponse.json(
      { ok: false, error: message },
      { status: 400 }
    );
  }
}
