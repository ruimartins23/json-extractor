import type { ParsedEvent } from './parser';

export interface TurnInfo {
  /** Number of turns in the session. */
  count: number;
  /** The 1-based turn each event belongs to, index-aligned with the events; 0 before anyone speaks. */
  turnOf: number[];
}

/**
 * A turn is one user side and one agent side, paired in order from the top,
 * whoever speaks first. A side is every line in a row from the same side, so two
 * agents speaking back to back across a transfer are still one reply. If the
 * session ends on a side with no partner, that side is still a turn of its own.
 *
 * Only a "user" line is the user's side. Everything else spoken, an agent name,
 * "agent" or "system", is the agent's side, the same split the timeline badges use.
 *
 * Tool calls, transfers and every other event belong to the turn of the last line
 * spoken before them, so turn boundaries still land correctly when transcripts are
 * filtered out of the timeline.
 */
export function computeTurns(events: ParsedEvent[]): TurnInfo {
  const turnOf = new Array<number>(events.length).fill(0);
  let sides = 0;
  let lastSide: 'user' | 'agent' | null = null;
  let turn = 0;

  events.forEach((event, i) => {
    if (event.type === 'message') {
      const side = (event.messageRole ?? '').toLowerCase() === 'user' ? 'user' : 'agent';
      if (side !== lastSide) {
        sides++;
        lastSide = side;
        turn = Math.ceil(sides / 2);
      }
    }
    turnOf[i] = turn;
  });

  return { count: Math.ceil(sides / 2), turnOf };
}
