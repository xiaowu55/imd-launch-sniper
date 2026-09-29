import { z } from "zod";
import { TESTNET_CHAIN_ID } from "./testnet-policy.js";
import type { LaunchHint } from "../src/launch-feed.js";

const block = z.object({
  number: z.string().regex(/^[1-9]\d{0,19}$/),
  hash: z.string().regex(/^0x[\da-fA-F]{64}$/),
}).strict();
const observationSchema = z.object({
  version: z.literal(1),
  chainId: z.literal(TESTNET_CHAIN_ID),
  startedAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
  anchor: block,
  baselineLiveIds: z.array(z.uuid()).max(10000),
  selectionLiveIds: z.array(z.uuid()).min(1).max(10000),
  discovery: z.object({
    launchId: z.uuid(),
    firstSeenAt: z.iso.datetime(),
    firstSeenHead: block,
    listCacheMaxAgeSeconds: z.number().int().nonnegative().max(86400).nullable(),
  }).strict(),
}).strict();

export type FreshObservation = z.infer<typeof observationSchema>;

export function validateFreshObservation(
  input: unknown,
  launchId: string,
  nowMs: number,
  launchBlock?: bigint,
): FreshObservation {
  const parsed = observationSchema.safeParse(input);
  if (!parsed.success) throw new Error("fresh_observation_invalid");
  const value = parsed.data;
  const start = Date.parse(value.startedAt);
  const deadline = Date.parse(value.deadlineAt);
  const seen = Date.parse(value.discovery.firstSeenAt);
  if (!Number.isFinite(nowMs) || deadline <= start || deadline - start > 30 * 60 * 1000 ||
      nowMs < start || nowMs >= deadline || seen < start || seen > nowMs || seen >= deadline)
    throw new Error("fresh_observation_expired");
  if (value.discovery.launchId.toLowerCase() !== launchId.toLowerCase() ||
      value.baselineLiveIds.some((id) => id.toLowerCase() === launchId.toLowerCase()) ||
      !value.selectionLiveIds.some((id) => id.toLowerCase() === launchId.toLowerCase()))
    throw new Error("fresh_launch_not_new");
  if (BigInt(value.discovery.firstSeenHead.number) < BigInt(value.anchor.number) ||
      (launchBlock !== undefined && launchBlock <= BigInt(value.anchor.number)))
    throw new Error("fresh_launch_before_anchor");
  if (launchBlock !== undefined && launchBlock > BigInt(value.discovery.firstSeenHead.number))
    throw new Error("fresh_discovery_head_before_launch");
  return value;
}

/** Reject stale selection if the official API withdraws it or presents another live ID. */
export function validateFreshLiveSet(
  observation: FreshObservation,
  rows: Array<Pick<LaunchHint, "id" | "chainId" | "status">>,
) {
  const selected = rows.filter((row) => row.id.toLowerCase() === observation.discovery.launchId.toLowerCase());
  if (selected.length !== 1 || selected[0]!.chainId !== TESTNET_CHAIN_ID || selected[0]!.status !== "live")
    throw new Error("fresh_candidate_withdrawn");
  const selectedSet = new Set(observation.selectionLiveIds.map((id) => id.toLowerCase()));
  if (rows.some((row) => row.chainId === TESTNET_CHAIN_ID && row.status === "live" && !selectedSet.has(row.id.toLowerCase())))
    throw new Error("fresh_api_candidates_changed");
}
