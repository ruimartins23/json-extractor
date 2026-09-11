import type { ParsedEvent } from './parser';

/**
 * Agent colours fan out around the accent's hue, so they harmonise with
 * whichever palette is chosen. Slots are handed out in order of first
 * appearance rather than by hashing the name: the hash put "steering agent" and
 * "account management" in the same slot, so the two agents in nearly every
 * multi-agent session shared a colour. Offsets skip 0, which the user badge and
 * every primary control already wear.
 */
const AGENT_OFFSETS = [60, -60, 150, -150, 105, -105, 30, -30];
const GENERIC_ROLES = new Set(['user', 'system']);
const slotsByEvents = new WeakMap<ParsedEvent[], Map<string, number>>();

/**
 * One key per agent however it is written. The flow map and the badges say
 * "Steering Agent", Scenario Check shortens it to "Steering", and all three have
 * to land on the same colour. A bare "agent" reduces to nothing and is skipped.
 */
function agentKey(name: string): string {
  return name.toLowerCase().replace(/\s*agent$/, '').trim();
}

/** Hue offset, in degrees from the accent, for the agent called `name`. */
export function agentOffset(events: ParsedEvent[], name: string): number {
  let slots = slotsByEvents.get(events);
  if (!slots) {
    slots = new Map();
    for (const e of events) {
      for (const candidate of [e.messageRole, e.raw?.agent]) {
        if (typeof candidate !== 'string') continue;
        const key = agentKey(candidate);
        if (key && !GENERIC_ROLES.has(key) && !slots.has(key)) slots.set(key, slots.size);
      }
    }
    slotsByEvents.set(events, slots);
  }

  const key = agentKey(name);
  let slot = slots.get(key);
  if (slot === undefined) {
    // A name no event carries: still stable, just not guaranteed distinct.
    slot = 0;
    for (let i = 0; i < key.length; i++) slot = (slot * 31 + key.charCodeAt(i)) >>> 0;
  }
  return AGENT_OFFSETS[slot % AGENT_OFFSETS.length];
}
