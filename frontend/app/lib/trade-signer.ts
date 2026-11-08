import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Wallet, Transaction, Interface, keccak256, toBeHex, formatUnits } from 'ethers';
import { PublicKey, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram, AddressLookupTableAccount } from '@solana/web3.js';
import { boundedFetch } from './bounded-fetch.ts';
import { analyzeCoin } from './coin-analyzer.ts';
import { fetchNativeCoinPrice } from './market-data.ts';
import { parseSwapQuote, validateEvmSwapIntent, ALLOWANCE_HOLDER, EVM_NATIVE, WSOL } from './swap-quotes.ts';
import { checkSpotDeviation, usdUnits, valueUsd } from './trade-policy.ts';
import { isOwner } from './auth.ts';
import type { TradePolicy } from './trade-policy.ts';
import type { ExecutionOrder, TradeStore } from './trade-store.ts';
import type { ApiInstruction, SwapQuote } from './trade-types.ts';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const CHAIN_IDS: Record<string,number> = { ethereum:1, base:8453, bsc:56, polygon:137, arbitrum:42161, optimism:10 };
const NATIVE_IDS: Record<string,string> = { solana:'solana', ethereum:'ethereum', base:'ethereum', bsc:'binancecoin', polygon:'matic-network', arbitrum:'ethereum', optimism:'ethereum' };
const ERC20 = new Interface(['function decimals() view returns(uint8)', 'function allowance(address,address) view returns(uint256)', 'function owner() view returns(address)']);
export type RpcCall = (chain: string, method: string, params: unknown[]) => Promise<unknown>;
export type SignedTrade = { raw: string; hash: string; kind: 'solana'|'evm'; lastValidBlockHeight?: number };
export type PreparedTrade = { costUsd: string; sign: () => Promise<SignedTrade> };
function object(value: unknown): Record<string,unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RPC data'); return value as Record<string,unknown>; }
function string(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('Invalid RPC string'); return value; }
function quantity(value: unknown): bigint { const s=string(value); if (!/^0x[0-9a-f]+$/i.test(s)) throw new Error('Invalid RPC quantity'); return BigInt(s); }
function accountBytes(value: unknown): Buffer { const a=object(value); if (!Array.isArray(a.data) || a.data[1]!=='base64') throw new Error('Invalid account encoding'); return Buffer.from(string(a.data[0]),'base64'); }
function ata(taker: string, mint: string): string { return PublicKey.findProgramAddressSync([new PublicKey(taker).toBuffer(), new PublicKey(TOKEN).toBuffer(), new PublicKey(mint).toBuffer()],new PublicKey(ATA))[0].toBase58(); }
function instruction(i: ApiInstruction): TransactionInstruction { return new TransactionInstruction({ programId:new PublicKey(i.programId), keys:i.accounts.map(a=>({pubkey:new PublicKey(a.pubkey),isSigner:a.isSigner,isWritable:a.isWritable})), data:Buffer.from(i.data,'base64') }); }
function hash8(name: string): Buffer { return createHash('sha256').update(`global:${name}`).digest().subarray(0,8); }
/** Versioned ABI policy: only the reviewed route/shared_accounts_route layouts from jup-ag/jupiter-cpi/idl.json. */
export function validateSolanaSwapIntent(quote: SwapQuote): void {
  const q=parseSwapQuote(quote); if (q.build.kind!=='solana') throw new Error('Expected Solana quote');
  const ix=q.build.swapInstruction, d=Buffer.from(ix.data,'base64');
  const shared=d.subarray(0,8).equals(hash8('shared_accounts_route'));
  if (!shared && !d.subarray(0,8).equals(hash8('route'))) throw new Error('Unreviewed Jupiter instruction ABI; signing blocked');
  let cursor=shared?9:8;
  if (d.length<cursor+4) throw new Error('Invalid route');
  const count=d.readUInt32LE(cursor); cursor+=4;
  if (count<1 || count>32) throw new Error('Invalid route plan');
  const oneByte=new Set([8,12,15,16,17,18,21,23,24,27,28]);
  for (let i=0;i<count;i++) {
    const variant=d[cursor++]; if (variant===undefined || variant>38) throw new Error('Unreviewed DEX instruction variant');
    const extra=oneByte.has(variant)?1:variant===29?16:variant===33?4:0;
    if (cursor+extra+3>d.length || (oneByte.has(variant) && d[cursor]>1)) throw new Error('Invalid route variant');
    cursor+=extra;
    const percent=d[cursor++]; const input=d[cursor++], output=d[cursor++];
    if (percent<1 || percent>100 || input>63 || output>63) throw new Error('Invalid route indices');
  }
  if (cursor+19!==d.length) throw new Error('Unexpected Jupiter arguments');
  const amount=d.readBigUInt64LE(cursor), out=d.readBigUInt64LE(cursor+8), slip=d.readUInt16LE(cursor+16), fee=d[cursor+18];
  if (amount!==BigInt(q.amountRaw) || out!==BigInt(q.amountOutRaw) || slip!==q.slippageBps || fee!==0 || out*BigInt(10000-slip)/10000n<BigInt(q.minOutRaw)) throw new Error('Jupiter intent amount/slippage mismatch');
  const keys=ix.accounts.map(k=>k.pubkey), source=ata(q.taker,q.inputToken), destination=ata(q.taker,q.outputToken);
  if (shared) {
    if (keys[0]!==TOKEN || keys[2]!==q.taker || keys[3]!==source || keys[6]!==destination || keys[7]!==q.inputToken || keys[8]!==q.outputToken || keys[9]!==JUPITER) throw new Error('Jupiter shared recipient mismatch');
  } else if (keys[0]!==TOKEN || keys[1]!==q.taker || keys[2]!==source || keys[3]!==destination || ![destination,JUPITER].includes(keys[4]) || keys[5]!==q.outputToken || keys[6]!==JUPITER) throw new Error('Jupiter recipient mismatch');
}
export function createTradeRpc(): RpcCall {
  return async (chain,method,params) => {
    const value=process.env[`TRADE_${chain.toUpperCase()}_RPC_URL`]; if (!value) throw new Error('Dedicated trading RPC is not configured');
    const url=new URL(value); if (url.protocol!=='https:' && !(url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw new Error('Unsafe trading RPC');
    const r=await boundedFetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    if (!r.ok) throw new Error('Trading RPC unavailable'); const result:unknown=await r.json(); const body=object(result);
    if (body.error!==undefined || !('result' in body)) throw new Error('Trading RPC rejected operation'); return body.result;
  };
}
async function keyFile(name: string): Promise<string> {
  const path=process.env[name]; if (!path) throw new Error('Isolated signer key file is not configured');
  const meta=await stat(path); if (!meta.isFile() || meta.size>4096 || (process.platform!=='win32' && (meta.mode&0o077)!==0)) throw new Error('Signer key permissions must be owner-only');
  return (await readFile(path,'utf8')).trim();
}
async function tokenDecimals(rpc:RpcCall,chain:string,token:string):Promise<number> {
  if (chain==='solana') {
    const response=object(await rpc(chain,'getAccountInfo',[token,{encoding:'base64',commitment:'confirmed'}]));
    const value=object(response.value), bytes=accountBytes(value);
    if (value.owner!==TOKEN || bytes.length!==82 || bytes[45]!==1 || bytes.readUInt32LE(0)!==0 || bytes.readUInt32LE(46)!==0) throw new Error('Only initialized legacy tokens with revoked authorities are supported live');
    return bytes[44];
  }
  const result=await rpc(chain,'eth_call',[{to:token,data:ERC20.encodeFunctionData('decimals')},'latest']);
  const value=quantity(result); if(value>255n)throw new Error('Invalid token decimals'); return Number(value);
}
async function valuation(rpc:RpcCall,q:SwapQuote,policy:TradePolicy):Promise<{notional:string;output:string;nativePrice:number}> {
  const native=q.chain==='solana'?WSOL:EVM_NATIVE;
  if ((q.inputToken===native)===(q.outputToken===native)) throw new Error('Live policy supports native/token pairs only');
  const asset=q.inputToken===native?q.outputToken:q.inputToken;
  const report=await analyzeCoin(asset,q.chain,{fresh:true});
  if (report.tradeGuardrail.status !== 'PASS') {
    const review = policy.assetReviews?.[`${q.chain}:${asset}`];
    const timeOnly = q.chain !== 'solana' && report.tradeGuardrail.blockedReasons.length === 0 && report.tradeGuardrail.warnings.length === 1 && report.tradeGuardrail.warnings[0] === 'audit_time_unknown';
    if (!timeOnly || !review || Date.parse(review.expiresAt) <= Date.now()) throw new Error('Fresh security evidence does not PASS; unknown age requires an explicit independent code review, not an AI override');
    const code = string(await rpc(q.chain, 'eth_getCode', [asset, 'latest']));
    const owner = string(await rpc(q.chain, 'eth_call', [{ to: asset, data: ERC20.encodeFunctionData('owner') }, 'latest']));
    if (keccak256(code).toLowerCase() !== review.codeHash || !/^0x0{64}$/.test(owner)) throw new Error('Reviewed immutable asset code or renounced Ownable state changed');
  }
  if (report.audit.token2022===true) throw new Error('Token-2022 live execution requires a separately reviewed policy');
  const nativePrice=await fetchNativeCoinPrice(NATIVE_IDS[q.chain]);
  if (nativePrice===null || report.market.priceUsd===null) throw new Error('USD valuation unknown');
  const decimals=await tokenDecimals(rpc,q.chain,asset), nativeDecimals=q.chain==='solana'?9:18;
  const notional=valueUsd(q.amountRaw,q.inputToken===native?nativeDecimals:decimals,q.inputToken===native?nativePrice:report.market.priceUsd);
  const output=valueUsd(q.minOutRaw,q.outputToken===native?nativeDecimals:decimals,q.outputToken===native?nativePrice:report.market.priceUsd);
  return {notional,output,nativePrice};
}
function addUsd(a:string,b:string):string { return formatUnits(usdUnits(a)+usdUnits(b),6); }
export async function prepareTrade(order: ExecutionOrder,policy:TradePolicy,rpc:RpcCall=createTradeRpc()):Promise<PreparedTrade> {
  const q=parseSwapQuote(order.quote);
  if (!policy.live || !policy.allowedChains.includes(q.chain) || (order.mode==='auto' && !policy.auto) || order.confirmedUpdateId===null || q.slippageBps>policy.maxSlippageBps || Date.parse(q.expiresAt)<=Date.now()) throw new Error('Trade permission/expiry check failed');
  if (!isOwner(Number(order.actor.userId), Number(order.actor.chatId))) throw new Error('Trading actor/chat authorization revoked');
  if (['base', 'optimism', 'arbitrum'].includes(q.chain)) throw new Error('L2 live signing blocked until a separately reviewed L1-data-fee bound is configured; read-only quotes remain available');
  const publicTaker=process.env[q.chain==='solana'?'TRADE_SOLANA_TAKER':'TRADE_EVM_TAKER'];
  if (!publicTaker || publicTaker.toLowerCase()!==q.taker.toLowerCase() || (q.chain==='solana' && publicTaker!==q.taker)) throw new Error('Dedicated taker mismatch');
  const values=await valuation(rpc,q,policy);
  checkSpotDeviation(values.notional,values.output,policy.maxDeviationBps);
  if (usdUnits(values.notional)>usdUnits(order.notionalUsd)) throw new Error('Input USD value increased; request a new quote');
  if (q.build.kind==='evm') {
    if (process.env.TRADE_EVM_MEV_PROTECTED!=='true') throw new Error('Operator-approved private EVM submission RPC required');
    validateEvmSwapIntent(q,Object.keys(policy.settlerCodeHashes));
    if (quantity(await rpc(q.chain,'eth_chainId',[]))!==BigInt(CHAIN_IDS[q.chain])) throw new Error('RPC chain mismatch');
    for (const [address,expected] of Object.entries(policy.settlerCodeHashes)) {
      const code=string(await rpc(q.chain,'eth_getCode',[address,'latest'])); if (code==='0x' || keccak256(code).toLowerCase()!==expected) throw new Error('Trusted EVM bytecode changed');
    }
    if (!policy.settlerCodeHashes[ALLOWANCE_HOLDER]) throw new Error('AllowanceHolder bytecode pin required');
    if (q.inputToken!==EVM_NATIVE) {
      const result=await rpc(q.chain,'eth_call',[{to:q.inputToken,data:ERC20.encodeFunctionData('allowance',[q.taker,ALLOWANCE_HOLDER])},'latest']);
      if (quantity(result)!==BigInt(q.amountRaw)) throw new Error('Owner must set exact AllowanceHolder allowance; no unlimited or automatic approvals');
    }
    const [pending,latest]=await Promise.all([rpc(q.chain,'eth_getTransactionCount',[q.taker,'pending']),rpc(q.chain,'eth_getTransactionCount',[q.taker,'latest'])]);
    if (quantity(pending)!==quantity(latest) || quantity(pending)>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Pending or invalid nonce; reconcile first');
    const b=q.build,fee=BigInt(b.gas)*BigInt(b.gasPrice);
    if (fee>policy.maxFeeNativeRaw) throw new Error('Network fee cap exceeded');
    const tx={from:q.taker,to:b.to,data:b.data,value:toBeHex(BigInt(b.value)),gas:toBeHex(BigInt(b.gas)),gasPrice:toBeHex(BigInt(b.gasPrice))};
    await rpc(q.chain,'eth_call',[tx,'latest']);
    const balance=quantity(await rpc(q.chain,'eth_getBalance',[q.taker,'latest']));
    if(balance<BigInt(b.value)+fee)throw new Error('Insufficient native balance including fee cap');
    const costUsd=addUsd(values.notional,valueUsd(fee,18,values.nativePrice));
    return {costUsd,sign:async()=>{
      const wallet=new Wallet(await keyFile('TRADE_EVM_KEY_FILE')); if(wallet.address.toLowerCase()!==q.taker)throw new Error('Signer address mismatch');
      const raw=await wallet.signTransaction({chainId:b.chainId,nonce:Number(quantity(pending)),to:b.to,data:b.data,value:BigInt(b.value),gasLimit:BigInt(b.gas),gasPrice:BigInt(b.gasPrice),type:0});
      const parsed=Transaction.from(raw); if(!parsed.hash || parsed.from?.toLowerCase()!==q.taker)throw new Error('Invalid EVM signature');
      return {raw,hash:parsed.hash,kind:'evm'};
    }};
  }
  validateSolanaSwapIntent(q);
  if (!/^[a-f0-9]{64}$/i.test(policy.solanaProgramDataHash) || policy.tipLamports<1000n || !policy.jitoTipAccount) throw new Error('Reviewed Jupiter program-data hash and Jito tip configuration required');
  if (!policy.solanaGenesisHash || await rpc(q.chain,'getGenesisHash',[]) !== policy.solanaGenesisHash) throw new Error('Solana RPC genesis hash mismatch');
  const programInfo=object(object(await rpc(q.chain,'getAccountInfo',[JUPITER,{encoding:'base64',commitment:'confirmed'}])).value);
  const programBytes=accountBytes(programInfo);
  if(programInfo.executable!==true || programInfo.owner!=='BPFLoaderUpgradeab1e11111111111111111111111' || programBytes.length!==36 || programBytes.readUInt32LE(0)!==2)throw new Error('Invalid Jupiter program account');
  const programData=new PublicKey(programBytes.subarray(4,36)).toBase58();
  const deployed=accountBytes(object(object(await rpc(q.chain,'getAccountInfo',[programData,{encoding:'base64',commitment:'confirmed'}])).value));
  if(createHash('sha256').update(deployed).digest('hex')!==policy.solanaProgramDataHash)throw new Error('Jupiter deployment changed');
  const tables:AddressLookupTableAccount[]=[];
  if (Object.keys(q.build.addressesByLookupTableAddress).length > 8) throw new Error('Lookup table budget exceeded');
  for(const [address,expected] of Object.entries(q.build.addressesByLookupTableAddress)) {
    const info=object(object(await rpc(q.chain,'getAccountInfo',[address,{encoding:'base64',commitment:'confirmed'}])).value);
    if(info.owner!=='AddressLookupTab1e1111111111111111111111111')throw new Error('Invalid address lookup table owner');
    const state=AddressLookupTableAccount.deserialize(accountBytes(info));
    if(expected.some((entry,i)=>state.addresses[i]?.toBase58()!==entry) || state.addresses.length!==expected.length)throw new Error('Lookup table mapping mismatch');
    tables.push(new AddressLookupTableAccount({key:new PublicKey(address),state}));
  }
  const tipAddress=new PublicKey(policy.jitoTipAccount);
  const tips=await jito('getTipAccounts',[]); if(!Array.isArray(tips) || !tips.includes(tipAddress.toBase58()))throw new Error('Unrecognized pinned Jito tip account');
  const compute=q.build.computeBudgetInstructions.filter(i=>Buffer.from(i.data,'base64')[0]!==2).map(instruction);
  // Fixed upper CU bound: no priority fee can escape the message fee cap below.
  const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),...compute,...q.build.setupInstructions.map(instruction),instruction(q.build.swapInstruction),...(q.build.cleanupInstruction?[instruction(q.build.cleanupInstruction)]:[]),SystemProgram.transfer({fromPubkey:new PublicKey(q.taker),toPubkey:tipAddress,lamports:policy.tipLamports})];
  const message=new TransactionMessage({payerKey:new PublicKey(q.taker),recentBlockhash:q.build.blockhash,instructions}).compileToV0Message(tables);
  const feeResult=object(await rpc(q.chain,'getFeeForMessage',[Buffer.from(message.serialize()).toString('base64'),{commitment:'confirmed'}]));
  if(typeof feeResult.value!=='number' || !Number.isSafeInteger(feeResult.value) || feeResult.value<0)throw new Error('Unknown Solana fee');
  const fee=BigInt(feeResult.value)+policy.tipLamports;
  if(fee>policy.maxFeeNativeRaw)throw new Error('Network fee/tip cap exceeded');
  const addresses=[q.taker,ata(q.taker,q.inputToken),ata(q.taker,q.outputToken)];
  const pre=object(await rpc(q.chain,'getMultipleAccounts',[addresses,{encoding:'base64',commitment:'confirmed'}]));
  if(!Array.isArray(pre.value) || pre.value.length!==3)throw new Error('Unknown pre-swap accounts');
  const unsigned=new VersionedTransaction(message);
  const sim=object(object(await rpc(q.chain,'simulateTransaction',[Buffer.from(unsigned.serialize()).toString('base64'),{encoding:'base64',sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses}}])).value);
  if(sim.err!==null || !Array.isArray(sim.accounts) || sim.accounts.length!==3)throw new Error('Swap simulation failed/incomplete');
  const balance=(value:unknown)=>{const a=object(value);if(typeof a.lamports!=='number'||!Number.isSafeInteger(a.lamports)||a.lamports<0)throw new Error('Unknown native balance');return BigInt(a.lamports);};
  const tokenBalance=(value:unknown,mint:string)=>{
    if(value===null)return 0n; const a=object(value),bytes=accountBytes(a);
    if(a.owner!==TOKEN||bytes.length!==165||new PublicKey(bytes.subarray(0,32)).toBase58()!==mint||new PublicKey(bytes.subarray(32,64)).toBase58()!==q.taker)throw new Error('Token account owner/mint mismatch');
    return bytes.readBigUInt64LE(64);
  };
  const nativeIn=q.inputToken===WSOL?BigInt(q.amountRaw):0n;
  if(balance(sim.accounts[0])<balance(pre.value[0])-nativeIn-fee-policy.maxRentLamports)throw new Error('Simulation native outflow exceeds intent');
  if(q.inputToken===WSOL && tokenBalance(pre.value[1],WSOL)!==0n)throw new Error('Existing wrapped SOL must be reconciled before using auto-wrap');
  if(q.inputToken!==WSOL && tokenBalance(pre.value[1],q.inputToken)-tokenBalance(sim.accounts[1],q.inputToken)>BigInt(q.amountRaw))throw new Error('Simulation token outflow exceeds intent');
  if(q.outputToken!==WSOL && tokenBalance(sim.accounts[2],q.outputToken)-tokenBalance(pre.value[2],q.outputToken)<BigInt(q.minOutRaw))throw new Error('Simulation minimum received not satisfied');
  if(q.outputToken===WSOL && balance(sim.accounts[0])+fee+policy.maxRentLamports-balance(pre.value[0])<BigInt(q.minOutRaw))throw new Error('Simulation native minimum not satisfied');
  const costUsd=addUsd(values.notional,valueUsd(fee+policy.maxRentLamports,9,values.nativePrice));
  return {costUsd,sign:async()=>{
    const rawKey:unknown=JSON.parse(await keyFile('TRADE_SOLANA_KEY_FILE'));
    if(!Array.isArray(rawKey)||rawKey.length!==64||rawKey.some(v=>!Number.isInteger(v)||v<0||v>255))throw new Error('Invalid isolated Solana key file');
    const key=Keypair.fromSecretKey(Uint8Array.from(rawKey));if(key.publicKey.toBase58()!==q.taker)throw new Error('Signer address mismatch');
    const tx=new VersionedTransaction(message);tx.sign([key]);
    // PublicKey's base58 codec accepts only 32 bytes; signatures use the wire-safe base64 below.
    const signature=base58(tx.signatures[0]);
    return {raw:Buffer.from(tx.serialize()).toString('base64'),hash:signature,kind:'solana',lastValidBlockHeight:q.build.kind==='solana'?q.build.lastValidBlockHeight:undefined};
  }};
}
function base58(bytes:Uint8Array):string {
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const b of bytes)n=n*256n+BigInt(b);
  let s='';while(n>0n){s=alphabet[Number(n%58n)]+s;n/=58n;}for(const b of bytes){if(b!==0)break;s='1'+s;}return s;
}
async function jito(method:string,params:unknown[]):Promise<unknown> {
  const endpoint=method==='getTipAccounts'?'https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts':'https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true';
  const r=await boundedFetch(endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if(!r.ok)throw new Error('Private Solana submission unavailable');const body=object(await r.json());if(body.error!==undefined)throw new Error('Jito rejected operation');return body.result;
}
function signedFrom(order:ExecutionOrder):SignedTrade {
  if(!order.signedPayload||!order.txHash)throw new Error('Missing write-ahead transaction');
  const v=object(JSON.parse(order.signedPayload));const raw=string(v.raw),hash=string(v.hash);if(hash!==order.txHash)throw new Error('Stored transaction hash mismatch');
  if(v.kind==='evm') {
    const tx=Transaction.from(raw),build=order.quote.build;
    if(build.kind!=='evm'||tx.hash!==hash||tx.from?.toLowerCase()!==order.quote.taker||tx.chainId!==BigInt(CHAIN_IDS[order.quote.chain])||tx.to?.toLowerCase()!==build.to||tx.data.toLowerCase()!==build.data.toLowerCase()||tx.value!==BigInt(build.value)||tx.gasLimit!==BigInt(build.gas)||tx.gasPrice!==BigInt(build.gasPrice))throw new Error('Stored EVM transaction differs from approved intent');
    return {raw,hash,kind:'evm'};
  }
  if(v.kind!=='solana'||typeof v.lastValidBlockHeight!=='number'||!Number.isSafeInteger(v.lastValidBlockHeight))throw new Error('Invalid signed transaction kind');
  const tx=VersionedTransaction.deserialize(Buffer.from(raw,'base64'));
  const publicKey=tx.message.staticAccountKeys[0];
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicKey.toBuffer()]),format:'der',type:'spki'});
  if(tx.message.header.numRequiredSignatures!==1||tx.signatures.length!==1||base58(tx.signatures[0])!==hash||publicKey.toBase58()!==order.quote.taker||!verify(null,tx.message.serialize(),key,tx.signatures[0]))throw new Error('Invalid stored Solana signature/transaction');
  return {raw,hash,kind:'solana',lastValidBlockHeight:v.lastValidBlockHeight};
}
export async function reconcileSigned(order:ExecutionOrder,policy:TradePolicy,rpc:RpcCall):Promise<'confirmed_onchain'|'failed'|'submitted'|'unknown'> {
  const signed=signedFrom(order),q=order.quote;
  if(signed.kind==='evm') {
    if(quantity(await rpc(q.chain,'eth_chainId',[]))!==BigInt(CHAIN_IDS[q.chain]))throw new Error('RPC chain mismatch');
    const receipt=await rpc(q.chain,'eth_getTransactionReceipt',[signed.hash]);
    if(receipt!==null){const r=object(receipt);if(r.transactionHash!==signed.hash||string(r.from).toLowerCase()!==q.taker)throw new Error('Receipt identity mismatch');
      const height=quantity(r.blockNumber),tip=quantity(await rpc(q.chain,'eth_blockNumber',[]));
      const block=object(await rpc(q.chain,'eth_getBlockByNumber',[r.blockNumber,false]));if(block.hash!==r.blockHash||tip<height||tip-height+1n<BigInt(policy.finalityBlocks))return 'unknown';
      const status=quantity(r.status);if(status!==0n&&status!==1n)throw new Error('Invalid receipt status');return status===1n?'confirmed_onchain':'failed';}
    const risk=(await rpc(q.chain,'eth_getTransactionByHash',[signed.hash]));if(risk!==null)return 'submitted';
    if(!policy.live||Date.parse(q.expiresAt)<=Date.now()||process.env.TRADE_EVM_MEV_PROTECTED!=='true')return 'unknown';
    await rpc(q.chain,'eth_sendRawTransaction',[signed.raw]);return 'submitted';
  }
  const statuses=object(await rpc(q.chain,'getSignatureStatuses',[[signed.hash],{searchTransactionHistory:true}]));
  if(!Array.isArray(statuses.value))throw new Error('Invalid signature status');
  const status=statuses.value[0];
  if(status!==null){
    const s=object(status);if(!('err' in s))throw new Error('Missing transaction outcome');
    if(s.confirmationStatus!=='finalized')return 'submitted';
    return s.err!==null?'failed':'confirmed_onchain';
  }
  const height=await rpc(q.chain,'getBlockHeight',[{commitment:'finalized'}]);
  if(typeof height!=='number'||!Number.isSafeInteger(height)||height<0||height>signed.lastValidBlockHeight!)return 'unknown';
  if(!policy.live||Date.parse(q.expiresAt)<=Date.now())return 'unknown';await jito('sendTransaction',[signed.raw,{encoding:'base64'}]);return 'submitted';
}
export async function runTradeOnce(store:TradeStore,policy:TradePolicy,rpc:RpcCall=createTradeRpc()):Promise<boolean> {
  const order=await store.claim(!policy.live);if(!order)return false;
  let writeAttempted = order.signedPayload !== null;
  try {
    const stopped = (await store.risk()).killed;
    if(order.signedPayload!==null){
      const mayBroadcast = !stopped && isOwner(Number(order.actor.userId),Number(order.actor.chatId)) && (order.mode!=='auto'||policy.auto);
      const status=await reconcileSigned(order,{...policy,live:policy.live&&mayBroadcast},rpc);await store.transition(order,status,null);return true;
    }
    if(stopped) {await store.transition(order,'failed','Kill switch active');return true;}
    if(Date.parse(order.quote.expiresAt)<=Date.now()){await store.transition(order,'expired','Quote expired; no requote or signing');return true;}
    const plan=await prepareTrade(order,policy,rpc);
    if(!await store.reserve(order,plan.costUsd,policy)){await store.transition(order,'failed','Risk reservation rejected; switch may be latched');return true;}
    const signed=await plan.sign();
    // Durable write MUST complete before the first outbound submission. A lost ACK never leads to a new nonce.
    writeAttempted = true;
    await store.writeSigned(order,JSON.stringify(signed),signed.hash);
    const durable={...order,signedPayload:JSON.stringify(signed),txHash:signed.hash};
    const status=await reconcileSigned(durable,policy,rpc);await store.transition(durable,status,null);
  } catch {
    // Do not assume an ambiguous persistence/submission error means failure. The next claim reads durable state.
    try{await store.transition(order,writeAttempted?'unknown':'failed','Execution rejected or result ambiguous; reconcile durable hash before retry');}catch{/* Storage ambiguity is retained, never converted into permission to re-sign. */}
  }
  return true;
}
