export interface ChallengeWindow {
  label: string;
  start: Date;
  end: Date;
}

function parseUtcDate(raw: string): Date {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid UTC date: ${raw}`);
  }
  return date;
}

export function loadChallengeWindows(env: NodeJS.ProcessEnv): ChallengeWindow[] {
  const defaults = [
    {
      label: "round1",
      start: env.ROUND1_START_UTC || "2026-03-27T16:00:00Z",
      end: env.ROUND1_END_UTC || "2026-03-27T16:30:00Z",
    },
    {
      label: "round2",
      start: env.ROUND2_START_UTC || "2026-03-27T17:00:00Z",
      end: env.ROUND2_END_UTC || "2026-03-27T17:30:00Z",
    },
  ];

  return defaults
    .map(window => ({
      label: window.label,
      start: parseUtcDate(window.start),
      end: parseUtcDate(window.end),
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function findActiveWindow(now: Date, windows: ChallengeWindow[]): ChallengeWindow | null {
  return windows.find(window => now >= window.start && now < window.end) ?? null;
}

export function nextWindow(now: Date, windows: ChallengeWindow[]): ChallengeWindow | null {
  return windows.find(window => now < window.start) ?? null;
}
