import type { Address, Hex } from "viem";

type ContractIdentity = Readonly<{ address: Address; codeHash: Hex }>;
export type ReviewedProjectDeployment = Readonly<{
  version: string;
  chainId: 11155111;
  policyVersions: readonly number[];
  factory: ContractIdentity;
  registry: ContractIdentity;
  guard: ContractIdentity;
  admissionFee: number;
  tradingFee: number;
  tickSpacing: number;
}>;

// Official launch handoffs #544, #539 and #535 and the project launch guide,
// Historical code was checked on Sentio; current code hashes and canonical
// blocks were independently corroborated on Sentio and PublicNode.
// Evidence and the public runtime bytecode are in test/fixtures/project-guard-v1.json.
// This catalog deliberately establishes no mainnet identity or future policy.
const reviewed: ReviewedProjectDeployment = Object.freeze({
  version: "sepolia-project-initialization-guard-v1",
  chainId: 11155111,
  policyVersions: Object.freeze([5, 6]),
  factory: Object.freeze({
    address: "0xbec6729d4f0b13017bd96f95bf82277a3dec2327",
    codeHash: "0xc5d6641b54e296e7a5f6969cc8db81962c1a78e9cf4daefbdcdfeea2844871b8",
  }),
  registry: Object.freeze({
    address: "0x9c84c1ddc58f869bdaad40d7f954ed9af6a5bfd3",
    codeHash: "0x88e40cb8e603322a0152673e3ee2f5b893ca6db3ae2a426d73bd1687d375e720",
  }),
  guard: Object.freeze({
    address: "0x1b7dae02cbe9ccd80ae77e1f51884a324f006000",
    codeHash: "0xbd068a5186c54ae7847a325543a333ae311d95da4ff238b940852e12117876b2",
  }),
  admissionFee: 3000,
  tradingFee: 12500,
  tickSpacing: 60,
});
const sepoliaDeployments = Object.freeze([reviewed]);
const noDeployments: readonly ReviewedProjectDeployment[] = Object.freeze([]);

/** Read-only observer hints. A catalog entry never authorizes a transaction by itself. */
export function reviewedProjectDeployments(chainId: number): readonly ReviewedProjectDeployment[] {
  return chainId === 11155111 ? sepoliaDeployments : noDeployments;
}
