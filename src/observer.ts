import { readBoundedJson } from "./bounded-json.js";
import { parseLaunchSnapshot } from "./launch-feed.js";
export async function fetchJson(url: string) {
  const signal = AbortSignal.timeout(8000);
  const r = await fetch(url, { signal, redirect: "error" });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  return readBoundedJson(r, 2 * 1024 * 1024, signal) as Promise<any>;
}
const short = (value: unknown) => typeof value === "string" && value.length <= 128 ? value : null;
/** Only small typed public fields can reach the local control API. */
export function publicObservation(latest: unknown, policies: unknown) {
  const snapshot = parseLaunchSnapshot(latest);
  const rows = policies && typeof policies === "object" && "policies" in policies && Array.isArray(policies.policies)
    ? policies.policies : [];
  return {
    checkedAt: snapshot.checkedAt,
    source: "https://api.imd.fun",
    launches: snapshot.launches,
    policies: rows.slice(0, 3).filter((x) => x && typeof x === "object").map((x) => ({
      version: short(x.version),
      kind: short(x.kind),
      chainId: Number.isSafeInteger(x.params?.chainId) && x.params.chainId > 0 ? x.params.chainId : null,
    })),
    mainnetVerified: false,
  };
}
export async function observeLaunches() {
  const [latest, policies] = await Promise.all([
    fetchJson("https://api.imd.fun/launches?limit=10"),
    fetchJson("https://api.imd.fun/launch/policies"),
  ]);
  return publicObservation(latest, policies);
}
