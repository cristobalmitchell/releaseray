import { afterEach, vi } from "vitest";

// Sets no environment variables: the core reads none, so any test that
// needs one is exposing a hidden dependency (CONVERSION-PLAN §6.5).
afterEach(() => {
  vi.clearAllMocks();
});
