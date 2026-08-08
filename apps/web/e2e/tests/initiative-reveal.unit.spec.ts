import { expect, test } from "@playwright/test";
import { shouldRevealInitiative } from "../../src/features/encounters/initiativeReveal";

test.describe("initiativeReveal transition guard (issue #1934)", () => {
  test("fires on preparing -> running transition", () => {
    const revealed = new Set<number>();
    const result = shouldRevealInitiative({
      prevStatus: "preparing",
      nextStatus: "running",
      encounterId: 42,
      revealedEncounterIds: revealed,
    });
    expect(result).toBe(true);
  });

  test("fires when rolledCount > 0 during preparing", () => {
    const revealed = new Set<number>();
    const result = shouldRevealInitiative({
      prevStatus: "preparing",
      nextStatus: "preparing",
      encounterId: 42,
      revealedEncounterIds: revealed,
      rolledCount: 3,
    });
    expect(result).toBe(true);
  });

  test("does NOT fire when rolledCount > 0 during running", () => {
    const revealed = new Set<number>();
    const result = shouldRevealInitiative({
      prevStatus: "running",
      nextStatus: "running",
      encounterId: 42,
      revealedEncounterIds: revealed,
      rolledCount: 3,
    });
    expect(result).toBe(false);
  });

  test("does NOT fire when encounter ID has already been revealed", () => {
    const revealed = new Set<number>([42]);
    const result = shouldRevealInitiative({
      prevStatus: "preparing",
      nextStatus: "running",
      encounterId: 42,
      revealedEncounterIds: revealed,
    });
    expect(result).toBe(false);
  });

  test("does NOT fire on running -> running refetch", () => {
    const revealed = new Set<number>();
    const result = shouldRevealInitiative({
      prevStatus: "running",
      nextStatus: "running",
      encounterId: 42,
      revealedEncounterIds: revealed,
    });
    expect(result).toBe(false);
  });

  test("resets/fires for a different encounter ID", () => {
    const revealed = new Set<number>([42]);
    const result = shouldRevealInitiative({
      prevStatus: "preparing",
      nextStatus: "running",
      encounterId: 99,
      revealedEncounterIds: revealed,
    });
    expect(result).toBe(true);
  });
});
