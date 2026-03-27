export const generateText = jest.fn(async ({ prompt }: { prompt: string }) => {
  // Default: return GREEN for tests that don't override
  return { text: "GREEN" };
});
