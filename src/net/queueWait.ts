/**
 * The queue's wait answer (modes redesign, November 2026): what POST /api/queue tells a player who
 * is still searching, so the client can show the clock, the estimate and the 5:00 bots match while
 * the player plays locally. Types and the client-version marker only. They live here, not in
 * protocol.ts, because protocol.ts is part of the node release closure and stays frozen.
 */
import type { GameMode } from '../sim/constants';

export interface QueueWait {
  /** Players searching this kind now, every region, you included (ranked: sharing a playlist with you). */
  searching: number;
  /** ... whose region is yours. */
  searchingHere: number;
  /** Since your search started (server clock; kept across a drop of up to 10 min). */
  waitedMs: number;
  /** Your search reaches every region now. */
  widened: boolean;
  /** Until it does; 0 once widened. */
  widenInMs: number;
  /** Rough time to a match, ms, rounded up; null = no estimate. Casual: never above botsInMs. */
  estimateMs: number | null;
  /** 'humans': another player is expected first; 'bots': the 5:00 online bots match comes first; 'none'. */
  estimateKind: 'humans' | 'bots' | 'none';
  /** Casual only: ms left to the online bots match (0 when due). */
  botsInMs?: number;
  /** A match could form but every server is full: you stay queued. */
  busy: boolean;
}

/**
 * The server a node match is played on, as the Worker knows it (never the node's own Welcome, whose
 * words are the node's): its name, and whether it is a community server, one whose host is not the
 * project (Prompt 2, A15: PARTIDO ENCONTRADO and the FINAL say so). A project server is never one.
 */
export interface ServerMark {
  name: string;
  community: boolean;
}

/**
 * Extra fields of a matched queue answer (the hub's; QueueResult itself is frozen). `server`: on a
 * node match, a community server's always, a project server's once the terms in force describe
 * hosting (the Worker's env.ts hostingTermsInForce); absent before, and on a MatchDO match.
 */
export interface QueueMatchedExtra { mode?: GameMode; host?: string; humans?: number; server?: ServerMark }

/** The client-version marker sent on /api/queue, POST /api/lobbies and POST /api/lobbies/join. */
export const QUEUE_API = 2;
