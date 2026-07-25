import { createContext, useContext } from 'react';
import type { Encounter } from '@campfire/schema';

const LiveEncounterContext = createContext<Encounter | null>(null);

/** Running encounter for the active campaign, when one exists. */
export function useLiveEncounter(): Encounter | null {
  return useContext(LiveEncounterContext);
}

export function LiveEncounterProvider({
  value,
  children,
}: {
  value: Encounter | null;
  children: React.ReactNode;
}) {
  return <LiveEncounterContext.Provider value={value}>{children}</LiveEncounterContext.Provider>;
}
