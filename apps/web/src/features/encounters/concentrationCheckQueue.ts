export type ConcentrationCheckPrompt = { combatantId: number; name: string; damage: number; dc: number };

export function appendConcentrationCheck(queue: readonly ConcentrationCheckPrompt[], prompt: ConcentrationCheckPrompt): ConcentrationCheckPrompt[] {
  return [...queue, prompt];
}

/** Use only after an explicit pass or a successful authoritative failure clear. */
export function dequeueConcentrationCheck(queue: readonly ConcentrationCheckPrompt[]): ConcentrationCheckPrompt[] {
  return queue.slice(1);
}
