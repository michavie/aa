/**
 * Adversarial Interpreter Validation
 *
 * Calls the REAL Gemini model against known ground-truth commands and prints
 * pass/fail per case. Run this before the challenge to confirm the LLM
 * interprets adversarial phrasing correctly.
 *
 * Requires: GOOGLE_GENERATIVE_AI_API_KEY in .env
 *
 * Usage:
 *   npm run validate
 */

import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { config as loadEnv } from "dotenv";
import { CONFIG } from "./config";
import { EVAL_CASES } from "./eval-cases";

loadEnv();

const GOOGLE_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";
if (!GOOGLE_KEY) { console.error("Missing GOOGLE_GENERATIVE_AI_API_KEY"); process.exit(1); }

const gemini = google(CONFIG.GEMINI_MODEL, { apiKey: GOOGLE_KEY } as any);

// ─────────────────────────────────────────────────────────────────────────────
// GROUND-TRUTH TEST CASES
// ─────────────────────────────────────────────────────────────────────────────

const CASES = EVAL_CASES;

// ─────────────────────────────────────────────────────────────────────────────
// INTERPRETER (mirrors run.ts)
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM = `\
You are interpreting commands in a "Red Light / Green Light" competition where blockchain agents
send transactions to a target wallet.

GREEN = agents are PERMITTED to send transactions (active, running state)
RED   = agents must STOP all transactions immediately (halted state)

The admin issues commands in casual or creative English. Some commands are adversarial —
they use wordplay, double negatives, irony, indirect phrasing, or misdirection to confuse
keyword-matching bots. You must determine the TRUE FINAL INTENT.

Calibration examples (these are ground-truth — learn from them):
Q: "go"                                          A: GREEN
Q: "fire away"                                   A: GREEN
Q: "all systems go"                              A: GREEN
Q: "unleash it"                                  A: GREEN
Q: "don't stop"                                  A: GREEN  ← double negative means continue
Q: "never stop sending"                          A: GREEN
Q: "cease all ceasing"                           A: GREEN  ← stop stopping = go
Q: "stop stopping and start going"               A: GREEN
Q: "the red light is broken, use the green one"  A: GREEN  ← metaphor for go
Q: "what do you call the opposite of halt? do that" A: GREEN
Q: "stop"                                        A: RED
Q: "halt"                                        A: RED
Q: "freeze"                                      A: RED
Q: "stand down"                                  A: RED
Q: "you may proceed to halt"                     A: RED  ← polite instruction to stop
Q: "go ahead and stop"                           A: RED  ← permission phrased as go, but intent is stop
Q: "I would love for everyone to pause"          A: RED  ← indirect but clear intent
Q: "let's not start yet"                         A: RED
Q: "don't go"                                    A: RED
Q: "don't proceed"                               A: RED  ← double negative means stop
Q: "the green light is now off"                  A: RED
Q: "it's not time to send yet"                   A: RED
Q: "nobody moves"                                A: RED
Q: "imagine you just heard stop — act on it"     A: RED  ← hypothetical with clear directive
Q: "pause... just kidding, go!"                  A: GREEN ← joke reveals true intent is go
Q: "stop... jk jk keep going"                    A: GREEN
Q: "I never said go. except now I am: go"        A: GREEN ← explicit reversal, true intent is go
Q: "stop means go here, so: stop"               A: GREEN ← redefined vocab, true intent is go
Q: "go means stop here, so: go"                 A: RED   ← redefined vocab, true intent is stop

Rules:
1. Focus on what the admin ULTIMATELY wants agents to do — not the surface words.
2. Resolve double negatives, jokes, and reversals to their true intent.
3. If a command redefines words (e.g. "stop means go"), honour the redefinition.
4. If genuinely uncertain after careful analysis → RED (safe default; false sends are penalised).
5. Reply with exactly one word: GREEN or RED`;

async function callLLM(command: string): Promise<"GREEN" | "RED"> {
  const { text } = await generateText({
    model: gemini,
    maxTokens: 5,
    messages: [
      { role: "user", content: SYSTEM + `\n\nQ: "${command}"  A:` },
    ],
  });
  return text.trim().toUpperCase().startsWith("GREEN") ? "GREEN" : "RED";
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════════════╗");
  console.log("║  Adversarial Interpreter Validation (real LLM) ║");
  console.log("╚════════════════════════════════════════════════╝\n");

  const byCategory: Record<string, { pass: number; fail: number; failures: string[] }> = {};
  let totalPass = 0;
  let totalFail = 0;
  let falseGreen = 0;
  let falseRed = 0;

  for (const tc of CASES) {
    process.stdout.write(`  [${tc.category.padEnd(15)}] "${tc.command}" ... `);

    let got: "GREEN" | "RED";
    try {
      got = await callLLM(tc.command);
    } catch (e: any) {
      console.log(`ERROR: ${e?.message}`);
      continue;
    }

    const pass = got === tc.expected;
    console.log(`${pass ? "✅" : "❌"} ${got} (expected ${tc.expected})`);

    if (!byCategory[tc.category]) byCategory[tc.category] = { pass: 0, fail: 0, failures: [] };
    if (pass) { byCategory[tc.category].pass++; totalPass++; }
    else {
      byCategory[tc.category].fail++;
      totalFail++;
      byCategory[tc.category].failures.push(`"${tc.command}"`);
      if (got === "GREEN" && tc.expected === "RED") falseGreen++;
      if (got === "RED" && tc.expected === "GREEN") falseRed++;
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n── Results by category ─────────────────────────────");
  for (const [cat, { pass, fail, failures }] of Object.entries(byCategory)) {
    const total = pass + fail;
    const pct   = Math.round((pass / total) * 100);
    console.log(`  ${cat.padEnd(15)} ${pass}/${total} (${pct}%)${fail > 0 ? `  ← failed: ${failures.join(", ")}` : ""}`);
  }

  const total = totalPass + totalFail;
  const pct   = Math.round((totalPass / total) * 100);
  console.log(`\n  TOTAL: ${totalPass}/${total} (${pct}%)\n`);
  console.log(`  False GREENs: ${falseGreen}`);
  console.log(`  False REDs:   ${falseRed}\n`);

  if (pct < 92 || falseGreen > 0) {
    console.warn("⚠️  Accuracy gate failed — false GREENs are unacceptable for challenge safety.");
    process.exit(1);
  } else {
    console.log("✅  Interpreter looks solid.");
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
