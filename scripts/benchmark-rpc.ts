// Read-only, paired local timing. No wallet, signer, simulation, or transaction submission.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readBoundedJson } from '../src/bounded-json.js';
import { blockIdentity, logsFingerprint, validateFixedRead } from './rpc-benchmark-validation.js';
import type { Hex } from 'viem';
const seconds = Number(process.argv[2] ?? 240);
const output = process.argv[3] ?? 'runtime/rpc-benchmark.json';
if (!Number.isInteger(seconds) || seconds < 120 || seconds > 600) throw Error('Duration must be 120..600 seconds');
const endpoints = [
  { name: 'publicnode', http: 'https://ethereum-rpc.publicnode.com', ws: 'wss://ethereum-rpc.publicnode.com' },
  { name: 'drpc', http: 'https://eth.drpc.org', ws: 'wss://eth.drpc.org' },
];
const manager = '0x000000000004444c5dc75cb358380d2e3de08a90';
type Method = 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getLogs' | 'eth_getCode';
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const t0 = performance.now();
const elapsed = () => Math.round((performance.now() - t0) * 100) / 100;
let id = 0;
const requests: Array<{source: string; method: string; phase: string; startMs: number; ms: number; ok: boolean; error?: string}> = [];
async function httpRpc(url: string, method: Method, params: unknown[] = []) {
  const requestId = ++id;
  const signal = AbortSignal.timeout(5000);
  const response = await fetch(url, { method: 'POST', headers: {'content-type':'application/json'}, redirect: 'error', signal,
    body: JSON.stringify({jsonrpc:'2.0', id:requestId, method, params}) });
  if (!response.ok) throw Error(`HTTP_${response.status}`);
  const data = await readBoundedJson(response, 2 * 1024 * 1024, signal) as any;
  if (data?.id !== requestId || data?.error || !Object.hasOwn(data, 'result')) throw Error(`RPC_${data?.error?.code ?? 'INVALID'}`);
  return data.result;
}
const events: Array<{source: string; atMs: number; number: number; hash: string}> = [];
let measuring = false;
let measurementEndMs = Infinity;
let fixedReference: { number: bigint; hash: string; logsHash: Hex } | undefined;
let baseline = 0;
function head(source: string, value: any) {
  if (!value || !/^0x[\da-f]+$/i.test(value.number) || !/^0x[\da-f]{64}$/i.test(value.hash)) throw Error('INVALID_HEAD');
  const number = Number(BigInt(value.number));
  if (!Number.isSafeInteger(number)) throw Error('INVALID_HEAD');
  if (measuring && elapsed() < measurementEndMs && number > baseline && !events.some(x => x.source === source && x.hash === value.hash.toLowerCase()))
    events.push({ source, atMs: elapsed(), number, hash: value.hash.toLowerCase() });
  return value;
}
class Ws {
  socket: WebSocket;
  pending = new Map<number, {resolve: (v:any)=>void; reject:(e:Error)=>void; timer: ReturnType<typeof setTimeout>}>();
  subscription?: string;
  verified = false;
  failures = 0;
  connectMs?: number;
  readyMs?: number;
  closed = false;
  constructor(readonly name: string, url: string) { this.socket = new WebSocket(url); }
  async connect() {
    const start = performance.now();
    this.socket.addEventListener('message', event => {
      try {
        const raw = String(event.data);
        if (raw.length > 2 * 1024 * 1024) throw Error('WS_TOO_LARGE');
        const data = JSON.parse(raw);
        const pending = this.pending.get(data.id);
        if (pending) {
          clearTimeout(pending.timer); this.pending.delete(data.id);
          if (data.error || !Object.hasOwn(data,'result')) pending.reject(Error(`RPC_${data.error?.code ?? 'INVALID'}`));
          else pending.resolve(data.result);
        } else if (this.verified && data.method === 'eth_subscription' && data.params?.subscription === this.subscription)
          head(this.name+'-ws', data.params.result);
      } catch { this.failures++; }
    });
    this.socket.addEventListener('close', () => {
      if (!this.closed) this.failures++;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('WS_CLOSED')); }
      this.pending.clear();
    });
    this.socket.addEventListener('error', () => { this.failures++; });
    await new Promise<void>((resolve,reject) => {
      const timer = setTimeout(()=>reject(Error('WS_CONNECT_TIMEOUT')),8000);
      this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      this.socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('WS_CONNECT_FAILED'));},{once:true});
    });
    this.connectMs = Math.round(performance.now()-start);
    if (await this.rpc('eth_chainId') !== '0x1') throw Error('WRONG_CHAIN');
    this.verified = true;
    const sub = await this.rpc('eth_subscribe', ['newHeads']);
    if (typeof sub !== 'string') throw Error('INVALID_SUBSCRIPTION');
    this.subscription = sub;
    this.readyMs = Math.round(performance.now()-start);
  }
  rpc(method: Method | 'eth_subscribe', params: unknown[] = []) {
    return new Promise<any>((resolve,reject)=>{
      if (this.socket.readyState !== WebSocket.OPEN) return reject(Error('WS_NOT_OPEN'));
      const requestId = ++id;
      const timer = setTimeout(()=>{this.pending.delete(requestId);reject(Error('WS_TIMEOUT'));},5000);
      this.pending.set(requestId,{resolve,reject,timer});
      this.socket.send(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}));
    });
  }
  close() { this.closed=true; this.socket.close(); }
}
const sockets = endpoints.map(e => new Ws(e.name,e.ws));
const sources = endpoints.flatMap((e,i)=>[
  {name:e.name+'-http', rpc:(m:Method,p:unknown[]=[])=>httpRpc(e.http,m,p)},
  {name:e.name+'-ws-rpc', rpc:(m:Method,p:unknown[]=[])=>sockets[i]!.rpc(m,p)},
]);
async function timed(source: typeof sources[number], method: Method, params: unknown[], phase: string) {
  const startMs=elapsed();
  try {
    const result=await source.rpc(method,params);
    if (method === 'eth_getBlockByNumber') blockIdentity(result);
    if (phase === 'fixed') validateFixedRead(method, result, fixedReference!);
    requests.push({source:source.name,method,phase,startMs,ms:Math.round((elapsed()-startMs)*100)/100,ok:true});
    return result;
  } catch(error) {
    const reason = error instanceof Error && /^(HTTP_|RPC_|WS_|WRONG_CHAIN|INVALID_)/.test(error.message) ? error.message : 'READ_FAILED';
    requests.push({source:source.name,method,phase,startMs,ms:Math.round((elapsed()-startMs)*100)/100,ok:false,error:reason});
    throw Error(reason);
  }
}
const stats=(values:number[])=>{
  const sorted=[...values].sort((a,b)=>a-b);
  const percentile=(p:number)=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??null;
  return {n:sorted.length,p50:percentile(.5),p95:percentile(.95),max:sorted.at(-1)??null};
};
const startedAt=new Date().toISOString();
try {
  const setup=await Promise.allSettled(sockets.map(ws=>ws.connect()));
  const wsSetup=setup.map((result,i)=>({name:sockets[i]!.name,ok:result.status==='fulfilled',connectMs:sockets[i]!.connectMs,readyMs:sockets[i]!.readyMs}));
  for(const e of endpoints) if(await httpRpc(e.http,'eth_chainId')!=='0x1') throw Error('WRONG_CHAIN');
  const warm=await Promise.all(sources.filter(s=>!s.name.includes('ws') || sockets.find(w=>s.name.startsWith(w.name))?.subscription).map(async source=>{
    let h:any;
    for(let n=0;n<3;n++) h=head(source.name,await timed(source,'eth_getBlockByNumber',['latest',false],'warmup'));
    return Number(BigInt(h.number));
  }));
  baseline=Math.max(...warm);
  const measurementStartMs=elapsed();
  measurementEndMs=measurementStartMs+seconds*1000;
  measuring=true;
  console.error(JSON.stringify({event:'head_comparison_started',seconds,baseline,wsSetup}));
  // At most one request per source; start-to-start 1 s where latency permits.
  await Promise.all(sources.map(async source=>{
    if(source.name.includes('ws')&&!sockets.find(w=>source.name.startsWith(w.name))?.subscription) return;
    while(elapsed()<measurementEndMs) {
      const start=elapsed();
      try {
        const h=await timed(source,'eth_getBlockByNumber',['latest',false],'heads');
        if(source.name.endsWith('-http')) head(source.name,h);
      } catch {}
      await pause(Math.max(0,Math.min(1000-(elapsed()-start),measurementEndMs-elapsed())));
    }
  }));
  measuring=false;
  const hashes=[...new Set(events.map(e=>e.hash))];
  const rows=hashes.map(hash=>{
    const es=events.filter(e=>e.hash===hash); const times=Object.fromEntries(es.map(e=>[e.source,e.atMs]));
    const http=es.filter(e=>e.source.endsWith('-http')); const ws=es.filter(e=>e.source.endsWith('-ws'));
    return {number:es[0]!.number,hash,times,httpPoolMs:http.length?Math.min(...http.map(e=>e.atMs)):null,wsPoolMs:ws.length?Math.min(...ws.map(e=>e.atMs)):null};
  }).sort((a,b)=>a.number-b.number);
  const canonical=await Promise.all(rows.map(async row=>{
    const hs=await Promise.allSettled(endpoints.map(e=>httpRpc(e.http,'eth_getBlockByNumber',['0x'+row.number.toString(16),false])));
    return {...row,verificationFailed:hs.some(h=>h.status==='rejected'),disagreement:hs.every(h=>h.status==='fulfilled')&&!hs.every(h=>h.status==='fulfilled'&&h.value?.hash?.toLowerCase()===row.hash),canonical:hs.every(h=>h.status==='fulfilled'&&h.value?.hash?.toLowerCase()===row.hash&&Number(BigInt(h.value.number))===row.number)};
  }));
  const valid=canonical.filter(r=>r.canonical&&r.httpPoolMs!==null&&r.wsPoolMs!==null);
  const deltas=valid.map(r=>r.httpPoolMs!-r.wsPoolMs!);
  const fixed=Math.max(baseline,...rows.map(r=>r.number))-2;
  const block='0x'+fixed.toString(16);
  const referenceBlocks = await Promise.all(endpoints.map(e=>httpRpc(e.http,'eth_getBlockByNumber',[block,false]).then(blockIdentity)));
  if(referenceBlocks.some(b=>b.number!==BigInt(fixed)||b.hash!==referenceBlocks[0]!.hash)) throw Error('INVALID_REFERENCE_BLOCK');
  const referenceLogs = await Promise.all(endpoints.map(e=>httpRpc(e.http,'eth_getLogs',[{fromBlock:block,toBlock:block,address:manager}]).then(logs=>logsFingerprint(logs,referenceBlocks[0]!))));
  if(referenceLogs[0]!==referenceLogs[1]) throw Error('INVALID_REFERENCE_LOGS');
  fixedReference={...referenceBlocks[0]!,logsHash:referenceLogs[0]!};
  console.error(JSON.stringify({event:'fixed_block_reads_started',canonicalPairedBlocks:valid.length,block:fixed}));
  // Same method, same pinned block, all endpoints issued concurrently. No eth_call or estimation.
  for(let round=0;round<20;round++) {
    for(const [method,params] of [
      ['eth_getBlockByNumber',[block,false]],
      ['eth_getLogs',[{fromBlock:block,toBlock:block,address:manager}]],
      ['eth_getCode',[manager,block]],
    ] as Array<[Method,unknown[]]>) {
      await Promise.allSettled(sources.filter(s=>!s.name.includes('ws')||sockets.find(w=>s.name.startsWith(w.name))?.subscription).map(s=>timed(s,method,params,'fixed')));
      await pause(250);
    }
  }
  const afterBlocks=await Promise.all(endpoints.map(e=>httpRpc(e.http,'eth_getBlockByNumber',[block,false]).then(blockIdentity)));
  const fixedStillCanonical=afterBlocks.every(b=>b.number===fixedReference!.number&&b.hash===fixedReference!.hash);
  if(!fixedStillCanonical) throw Error('INVALID_FIXED_REORG');
  const metrics=sources.map(s=>({source:s.name,methods:['heads:eth_getBlockByNumber','fixed:eth_getBlockByNumber','fixed:eth_getLogs','fixed:eth_getCode'].map(key=>{
    const [phase,method]=key.split(':');const sample=requests.filter(r=>r.source===s.name&&r.phase===phase&&r.method===method);
    return {phase,method,attempts:sample.length,errors:sample.filter(r=>!r.ok).length,ms:stats(sample.filter(r=>r.ok).map(r=>r.ms))};
  })}));
  const report={startedAt,finishedAt:new Date().toISOString(),mode:'READ_ONLY_MAINNET_BENCHMARK',schemaVersion:2,fixedReference:{...fixedReference,number:fixedReference.number.toString()},fixedStillCanonical,seconds,pollIntervalMs:1000,measurementStartMs,measurementEndMs,baseline,endpoints,wsSetup,
    wsFailures:sockets.map(s=>({name:s.name,failures:s.failures})),
    methodology:'Local monotonic first arrival of the same block hash. Only hashes independently corroborated by both HTTP providers enter paired comparisons. Positive HTTP-minus-WS means WS notification arrived sooner. Pool = earliest among two providers, measured concurrently; not inclusion/transaction latency. HTTP/WS RPC RTT is a separate metric. Fixed reads are individually validated against a two-HTTP-provider block/log reference and the pinned PoolManager code hash; fixed block rechecked afterwards. Coverage is within the observed union, not the complete chain. All warm connections; WS handshake is reported separately. Warmup excluded; no signer, send, eth_call, gas estimation, or fork.',
    headComparison:{observedCanonical:canonical.filter(r=>r.canonical).length,httpOnly:canonical.filter(r=>r.canonical&&r.httpPoolMs!==null&&r.wsPoolMs===null).length,wsOnly:canonical.filter(r=>r.canonical&&r.wsPoolMs!==null&&r.httpPoolMs===null).length,verificationFailed:canonical.filter(r=>r.verificationFailed).length,disagreement:canonical.filter(r=>r.disagreement).length,canonicalPairs:valid.length,wsWins:deltas.filter(d=>d>0).length,httpWins:deltas.filter(d=>d<0).length,httpMinusWsMs:stats(deltas),windows:[0,1].map(w=>{
      const rs=valid.filter(r=>Math.min(r.httpPoolMs!,r.wsPoolMs!)>=measurementStartMs+w*seconds*500&&Math.min(r.httpPoolMs!,r.wsPoolMs!)<measurementStartMs+(w+1)*seconds*500);
      return {half:w+1,httpMinusWsMs:stats(rs.map(r=>r.httpPoolMs!-r.wsPoolMs!))};
    }),perSource:['publicnode-http','drpc-http','publicnode-ws','drpc-ws'].map(source=>({source,observed:canonical.filter(r=>r.canonical&&r.times[source]!==undefined).length,lagFromEarliestMs:stats(valid.filter(r=>r.times[source]!==undefined).map(r=>r.times[source]!-Math.min(...Object.values(r.times))))}))},metrics,blocks:canonical,requests};
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output,headComparison:report.headComparison,metrics},null,2));
} finally { for(const socket of sockets) socket.close(); }
