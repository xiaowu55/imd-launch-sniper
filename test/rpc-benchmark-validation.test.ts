import test from 'node:test';
import assert from 'node:assert/strict';
import { blockIdentity, logsFingerprint, validateFixedRead } from '../scripts/rpc-benchmark-validation.js';
import { MAINNET_PROTOCOL } from '../src/api-launch.js';
const hash = `0x${'a'.repeat(64)}`;
const block = {number: 100n, hash};
const log = {address:MAINNET_PROTOCOL.poolManager.address,blockNumber:'0x64',blockHash:hash,transactionHash:`0x${'b'.repeat(64)}`,transactionIndex:'0x1',logIndex:'0x2',removed:false,data:'0x1234',topics:[`0x${'c'.repeat(64)}`]};
const reference = {...block, logsHash:logsFingerprint([log],block)};
test('a fast null, old block, or different fork cannot count as a valid fixed-block response',()=>{
  assert.throws(()=>blockIdentity(null));
  assert.throws(()=>validateFixedRead('eth_getBlockByNumber',{number:'0x63',hash},reference));
  assert.throws(()=>validateFixedRead('eth_getBlockByNumber',{number:'0x64',hash:`0x${'d'.repeat(64)}`},reference));
  assert.doesNotThrow(()=>validateFixedRead('eth_getBlockByNumber',{number:'0x64',hash},reference));
});
test('fast empty or substituted logs and duplicate indexes are excluded from successful timings',()=>{
  assert.throws(()=>validateFixedRead('eth_getLogs',[],reference));
  assert.throws(()=>validateFixedRead('eth_getLogs',[{...log,removed:true}],reference));
  assert.throws(()=>validateFixedRead('eth_getLogs',[{...log,blockNumber:'0x63'}],reference));
  assert.throws(()=>validateFixedRead('eth_getLogs',[{...log,data:'0x5678'}],reference));
  assert.throws(()=>logsFingerprint([log,log],block));
  assert.doesNotThrow(()=>validateFixedRead('eth_getLogs',[log],reference));
});
test('log fingerprint ignores JSON field order and normalizes hex case and numeric quantities',()=>{
  const alternate={...log, blockNumber:'0x064',transactionIndex:'0x01',address:log.address.toUpperCase().replace('0X','0x')};
  assert.equal(logsFingerprint([alternate],block),reference.logsHash);
});
test('empty, malformed and substituted contract code cannot win the latency comparison',()=>{
  for(const code of ['0x','0x6000','0x1',null]) assert.throws(()=>validateFixedRead('eth_getCode',code,reference));
});
