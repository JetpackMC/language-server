import eventNames from "../data/events.json";

export const KNOWN_EVENTS: ReadonlySet<string> = new Set(eventNames as string[]);

export function isKnownEvent(name: string): boolean {
  return KNOWN_EVENTS.has(name);
}
