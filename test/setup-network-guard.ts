import { afterEach } from "vitest";
import { processGuard } from "./no-network.js";

// Process-level guard for ALL test files: blocks every non-loopback destination and fails the test on any attempt.
processGuard.install();

afterEach(() => {
  try {
    processGuard.assertNoAttempts();
  } finally {
    processGuard.clear();
  }
});
