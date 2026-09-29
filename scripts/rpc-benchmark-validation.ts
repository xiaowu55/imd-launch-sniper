import { keccak256, stringToHex, type Hex } from 'viem';
import { MAINNET_PROTOCOL } from '../src/api-launch.js';
const hex = (v: unknown, bytes?: number): v is Hex => typeof v === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(v) && (bytes === undefined || v.length === 2 + bytes * 2);
const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x[\da-f]+$/i.test(v)) throw Error('INVALID_QUANTITY');
  return BigInt(v);
};
export function blockIdentity(value: unknown): { number: bigint; hash: string } {
  const b = value as Record<string,unknown> | null;
  if (!b || !hex(b.hash,32)) throw Error('INVALID_BLOCK');
  const number=quantity(b.number);
  if(number>BigInt(Number.MAX_SAFE_INTEGER)) throw Error('INVALID_BLOCK');
  return {number,hash:b.hash.toLowerCase()};
}
export function logsFingerprint(value: unknown, block: {number:bigint;hash:string}): Hex {
  if(!Array.isArray(value)||value.length>10000) throw Error('INVALID_LOGS');
  const indexes=new Set<string>();
  const logs=value.map(log=>{
    if(!log || typeof log!=='object' || !hex(log.address,20) || log.address.toLowerCase()!==MAINNET_PROTOCOL.poolManager.address ||
      !hex(log.blockHash,32) || log.blockHash.toLowerCase()!==block.hash || quantity(log.blockNumber)!==block.number ||
      !hex(log.transactionHash,32) || log.removed!==false || !hex(log.data) ||
      !Array.isArray(log.topics)||log.topics.length>4||!log.topics.every((t:unknown)=>hex(t,32))) throw Error('INVALID_LOGS');
    const index=quantity(log.logIndex).toString();
    if(indexes.has(index)) throw Error('INVALID_LOGS_DUPLICATE');
    indexes.add(index);
    return {address:log.address.toLowerCase(),blockHash:block.hash,blockNumber:block.number.toString(),transactionHash:log.transactionHash.toLowerCase(),
      transactionIndex:quantity(log.transactionIndex).toString(),logIndex:index,data:log.data.toLowerCase(),topics:log.topics.map((t:string)=>t.toLowerCase())};
  }).sort((a,b)=>BigInt(a.logIndex)<BigInt(b.logIndex)?-1:1);
  return keccak256(stringToHex(JSON.stringify(logs)));
}
export function validateFixedRead(method: string, value: unknown, reference: {number:bigint;hash:string;logsHash:Hex}) {
  if(method==='eth_getBlockByNumber') {
    const actual=blockIdentity(value);
    if(actual.number!==reference.number||actual.hash!==reference.hash) throw Error('INVALID_BLOCK_IDENTITY');
  } else if(method==='eth_getCode') {
    if(!hex(value)||keccak256(value)!==MAINNET_PROTOCOL.poolManager.codeHash) throw Error('INVALID_CONTRACT_CODE');
  } else if(method==='eth_getLogs') {
    if(logsFingerprint(value,reference)!==reference.logsHash) throw Error('INVALID_LOGS_FINGERPRINT');
  } else throw Error('INVALID_BENCHMARK_METHOD');
}
