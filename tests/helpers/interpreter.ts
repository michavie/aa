/**
 * Interpreter logic extracted for testing — mirrors the interpret() function in run.ts.
 */

import { generateText } from "ai";
import { google } from "@ai-sdk/google";

const gemini = google("gemini-3.1-flash-lite-preview");
const interpretCache = new Map<string, "GREEN" | "RED">();

export function clearCache() {
  interpretCache.clear();
}

export async function interpretCommand(rawCommand: string): Promise<"GREEN" | "RED"> {
  const key = rawCommand.trim().toLowerCase();
  if (interpretCache.has(key)) return interpretCache.get(key)!;

  try {
    const { text } = await Promise.race([
      generateText({
        model: gemini,
        maxTokens: 10,
        prompt: `You are interpreting a Red Light / Green Light command. Reply GREEN or RED.\n\nCommand: "${rawCommand}"`,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 100)),
    ]);

    const result: "GREEN" | "RED" = text.trim().toUpperCase().startsWith("GREEN") ? "GREEN" : "RED";
    interpretCache.set(key, result);
    return result;
  } catch {
    return "RED";
  }
}
