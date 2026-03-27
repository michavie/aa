/**
 * LLM command interpreter tests
 *
 * The interpreter must correctly handle:
 * - Clear green/red commands
 * - Adversarial / tricky phrasing
 * - Timeouts and LLM failures → safe default (RED)
 * - Caching (same command not re-interpreted)
 */

import { generateText } from "ai";
import { interpretCommand, clearCache } from "./helpers/interpreter";

const mockGenerateText = generateText as jest.MockedFunction<typeof generateText>;

beforeEach(() => {
  clearCache();
  mockGenerateText.mockReset();
});

describe("Interpreter — clear commands", () => {
  test("'go' → GREEN", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "GREEN" } as any);
    expect(await interpretCommand("go")).toBe("GREEN");
  });

  test("'stop' → RED", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "RED" } as any);
    expect(await interpretCommand("stop")).toBe("RED");
  });

  test("'halt all transactions' → RED", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "RED" } as any);
    expect(await interpretCommand("halt all transactions")).toBe("RED");
  });

  test("'fire away' → GREEN", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "GREEN" } as any);
    expect(await interpretCommand("fire away")).toBe("GREEN");
  });
});

describe("Interpreter — adversarial commands", () => {
  test("LLM correctly interprets double-negative", async () => {
    // "don't stop" → LLM should say GREEN
    mockGenerateText.mockResolvedValueOnce({ text: "GREEN" } as any);
    expect(await interpretCommand("don't stop now")).toBe("GREEN");
  });

  test("LLM correctly handles joke/mislead pattern", async () => {
    // "stop... just kidding, go!" → GREEN
    mockGenerateText.mockResolvedValueOnce({ text: "GREEN" } as any);
    expect(await interpretCommand("stop... just kidding, go!")).toBe("GREEN");
  });

  test("ambiguous or non-matching LLM output → RED (safe default)", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "UNCLEAR" } as any);
    expect(await interpretCommand("maybe do something?")).toBe("RED");
  });
});

describe("Interpreter — failure modes", () => {
  test("LLM timeout → RED", async () => {
    mockGenerateText.mockImplementationOnce(() =>
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10))
    );
    const result = await interpretCommand("go");
    expect(result).toBe("RED");
  });

  test("LLM network error → RED", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("network error"));
    expect(await interpretCommand("start sending")).toBe("RED");
  });

  test("LLM partial response (no GREEN/RED) → RED", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "" } as any);
    expect(await interpretCommand("proceed")).toBe("RED");
  });
});

describe("Interpreter — caching", () => {
  test("same command only calls LLM once", async () => {
    mockGenerateText.mockResolvedValue({ text: "GREEN" } as any);
    await interpretCommand("go");
    await interpretCommand("go");
    await interpretCommand("GO"); // case-insensitive
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  test("different commands each call LLM", async () => {
    mockGenerateText.mockResolvedValue({ text: "RED" } as any);
    await interpretCommand("stop");
    await interpretCommand("halt");
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  test("clearCache forces re-interpretation", async () => {
    mockGenerateText.mockResolvedValue({ text: "GREEN" } as any);
    await interpretCommand("go");
    clearCache();
    await interpretCommand("go");
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });
});
