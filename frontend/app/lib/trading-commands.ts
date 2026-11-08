import { createHash } from 'node:crypto';
import { normalizeAddress, normalizeChain, escapeHtml, isOwner } from './auth.ts';
import { analyzeCoin } from './coin-analyzer.ts';
import { getHermesNarrative } from './hermes-ai.ts';
import type { CoinAnalysis } from './coin-analyzer.ts';
import { createPaperStore, openPaperTrade, settleDuePaperTrades, summarizePaperTrades } from './paper-trading.ts';
import type { PaperHorizon } from './paper-trading.ts';
import { createTradeStore } from './trade-store.ts';
import { requestSwapQuote } from './swap-quotes.ts';
import { positiveUsd } from './trade-policy.ts';
import type { TradeActor, TradeOrder } from './trade-types.ts';
import type { BotStore } from './bot-store.ts';
import type { InlineKeyboard } from './bot-commands.ts';

export const TRADING_HELP = '\n/paper [1h|6h|24h] — hasil simulasi dan coverage\n/paper open <chain> <token> <notionalUSD> — posisi virtual\n/paper evaluate — evaluasi horizon yang jatuh tempo\n/quote <chain> <input|native> <output|native> <amountRaw> <maxUSD> <slippageBps> — kuotasi 30 detik\n/trade — status order dan risk switch\n/trade kill — hentikan signing baru\n/trade reset — konfirmasi buka switch, tidak menghapus budget';
export type TradingCommandContext = TradeActor & { updateId:number; store:BotStore; confirmed:boolean; send:(html:string,keyboard?:InlineKeyboard)=>Promise<void>; confirm:(command:string)=>Promise<string> };
function costs() {
  const entryFeeUsd=process.env.PAPER_ENTRY_FEE_USD, exitFeeUsd=process.env.PAPER_EXIT_FEE_USD, value=process.env.PAPER_SLIPPAGE_BPS;
  if(!entryFeeUsd||!exitFeeUsd||value===undefined||!/^\d+$/.test(value)||Number(value)>=10000)throw new Error('Isi PAPER_ENTRY_FEE_USD, PAPER_EXIT_FEE_USD dan PAPER_SLIPPAGE_BPS secara eksplisit.');
  return {entryFeeUsd,exitFeeUsd,entrySlippageBps:Number(value),exitSlippageBps:Number(value)};
}
const priceText = (value: number) => value.toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
export async function recordPaperCandidate(store:BotStore, actor:TradeActor, signalId:string, chain:string, token:string, notionalUsd:string):Promise<void> {
  const explicitCosts=costs();
  const report=await analyzeCoin(token,chain,{fresh:true});
  if(report.market.priceUsd===null)throw new Error('Harga entry paper tidak tersedia; tidak membuat entry palsu.');
  const hermes=await getHermesNarrative(report);
  await store.ensureLease();
  await openPaperTrade(createPaperStore(),store.fence(),{signalId,actor,chain,token,entryAt:new Date().toISOString(),entryPriceUsd:priceText(report.market.priceUsd),notionalUsd,...explicitCosts,analysis:report,hermes});
}
export async function evaluatePaper(store:BotStore):Promise<number> {
  const snapshots=new Map<string,Promise<CoinAnalysis>>();
  return settleDuePaperTrades(createPaperStore(),store.fence(),async trade=>{
    const key=`${trade.chain}:${trade.token}`;
    let pending=snapshots.get(key);if(!pending){pending=analyzeCoin(trade.token,trade.chain,{fresh:true});snapshots.set(key,pending);}
    const r=await pending;
    return {observedAt:r.fetchedAt,priceUsd:r.market.priceUsd===null?null:priceText(r.market.priceUsd),liquidityUsd:r.market.liquidityUsd===null?null:priceText(r.market.liquidityUsd),source:'Current provider snapshot at fetchedAt, not an historical execution quote'};
  },new Date().toISOString(),300000,8,()=>new Date().toISOString());
}
function orderMessage(order:TradeOrder):string {
  const q=order.quote;
  return `<b>Kuotasi ${escapeHtml(q.chain)} — ${escapeHtml(order.status)}</b>\nID: <code>${order.id}</code>\nInput: <code>${escapeHtml(q.inputToken)}</code>\nJumlah RAW: ${q.amountRaw}\nOutput: <code>${escapeHtml(q.outputToken)}</code>\nEstimasi raw: ${q.amountOutRaw}; minimum raw: <b>${q.minOutRaw}</b>\nSlippage: ${q.slippageBps} bps | Price impact: ${q.priceImpactBps===null?'UNKNOWN':`${q.priceImpactBps} bps`}\nBatas notional pemilik: $${order.notionalUsd}\nBiaya: ${escapeHtml(q.feesDescription)}\nFee native raw: ${q.feeNativeRaw??'UNKNOWN (divalidasi signer)'}\nBerlaku sampai: ${q.expiresAt}\n${q.build.kind==='evm'&&q.build.allowance?'Allowance kurang. Pemilik harus menyiapkan approval exact ke AllowanceHolder; bot tidak memberi unlimited approval.\n':''}Live: ${process.env.TRADE_LIVE_ENABLED==='true'?'diizinkan konfigurasi signer; belum berarti transaksi terkirim':'OFF; tidak ada uang dipindahkan'}.`;
}
export async function handleTradingCommand(text:string,c:TradingCommandContext):Promise<boolean> {
  const p=text.trim().split(/\s+/),command=p[0]?.toLowerCase();
  if(!['/paper','/quote','/trade'].includes(command))return false;
  try {
    if(!isOwner(Number(c.userId),Number(c.chatId)))throw new Error('Owner/chat ditolak.');
    if(command==='/paper') {
      if(p[1]==='open') {
        if(p.length!==5)throw new Error('Gunakan /paper open <chain> <token> <notionalUSD>.');
        const chain=normalizeChain(p[2]),token=normalizeAddress(chain,p[3]),notional=positiveUsd(p[4]);
        await recordPaperCandidate(c.store,c,`manual:${c.chatId}:${c.updateId}`,chain,token,notional);
        await c.send('Entry paper disimpan secara durable, bukan pembelian. Horizon 1h/6h/24h memakai snapshot saat observasi dan biaya simulasi eksplisit.');
      } else if(p[1]==='evaluate'&&p.length===2) {
        const n=await evaluatePaper(c.store);await c.send(`Observasi paper disimpan: ${n}. Yang terlambat/tidak tersedia tidak dianggap harga historis atau profit.`);
      } else {
        const horizon=p[1]??'24h';if(p.length>2||!['1h','6h','24h'].includes(horizon))throw new Error('Gunakan /paper [1h|6h|24h].');
        const rows=await createPaperStore().list(c,1000),summary=summarizePaperTrades(rows,horizon as PaperHorizon);
        const pct=(v:number|null)=>v===null?'UNKNOWN':`${(v*100).toFixed(2)}%`;
        const format=(label:string,r:typeof summary.baseline)=>`${label}: ${r.evaluated}/${r.eligible} dievaluasi; missing ${r.missing}, delayed ${r.delayed}, unavailable ${r.unavailable}\nReturn mean bersih: ${pct(r.netReturn)}; win rate: ${pct(r.winRate)}; drawdown cumulative-return: ${pct(r.maxDrawdown)}`;
        await c.send(`<b>Paper ${horizon} — bukan uang riil</b>\n${format('Baseline',summary.baseline)}\n${format('Filter evidence Hermes',summary.filtered)}\nCakupan maksimal 1000 entry terbaru milik actor/chat ini. Drawdown bukan ekuitas wallet; biaya/slippage simulasi sudah dikurangi. AI ranking bukan rekomendasi BUY. Tidak ada klaim out-of-sample dari data live ini.`);
      }
    } else if(command==='/quote') {
      if(p.length!==7)throw new Error('Gunakan /quote <chain> <input|native> <output|native> <amountRaw> <maxUSD> <slippageBps>.');
      const id=createHash('sha256').update(`quote:${c.chatId}:${c.updateId}`).digest('hex').slice(0,32),storage=createTradeStore();
      let order=await storage.get(id,c);
      if(!order) {
        const chain=normalizeChain(p[1]),taker=process.env[chain==='solana'?'TRADE_SOLANA_TAKER':'TRADE_EVM_TAKER'];
        if(!taker)throw new Error('Isi public TRADE_SOLANA_TAKER / TRADE_EVM_TAKER khusus bot; bukan private key.');
        const native=chain==='solana'?'So11111111111111111111111111111111111111112':'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
        const token=(s:string)=>s==='native'?native:normalizeAddress(chain,s);
        const input=token(p[2]),output=token(p[3]);
        // A readable quote may be WARN, but incomplete/blocked evidence cannot silently proceed.
        const reports=await Promise.all([...new Set([input,output].filter(t=>t!==native))].map(t=>analyzeCoin(t,chain,{fresh:true})));
        if(reports.some(r=>r.tradeGuardrail.status==='BLOCKED'))throw new Error('Kuotasi ditolak: audit/market/authority/holder/tax belum lolos guardrail.');
        const slippage=Number(p[6]);if(!/^\d+$/.test(p[6])||!Number.isInteger(slippage)||slippage<0||slippage>150)throw new Error('Slippage harus 0–150 bps; signer dapat membatasi lebih rendah.');
        const quote=await requestSwapQuote({chain,inputToken:input,outputToken:output,amountRaw:p[4],taker,slippageBps:slippage});
        order={id,actor:{userId:c.userId,chatId:c.chatId},quote,notionalUsd:positiveUsd(p[5]),mode:'manual',status:'quoted',confirmedUpdateId:null,txHash:null,signedPayload:null,error:null};
        await c.store.ensureLease();await storage.create(order,c.store.fence());
      }
      const token=await c.confirm(`/trade execute ${id}`);
      await c.send(orderMessage(order),order.status==='quoted'&&Date.parse(order.quote.expiresAt)>Date.now()?[[{text:'Konfirmasi quote ini',callback_data:`confirm:${token}`}]]:undefined);
    } else {
      const storage=createTradeStore();
      if(p[1]==='kill'&&p.length===2){await storage.setKill(true,'Owner Telegram kill switch',c.store.fence());await c.send('Kill switch aktif. Signing baru dihentikan; transaksi yang sudah disiarkan tetap perlu rekonsiliasi.');}
      else if(p[1]==='reset'&&p.length===2){
        if(!c.confirmed){const t=await c.confirm('/trade reset');await c.send('Buka kill switch? Budget/reservasi tidak dihapus dan tidak ada transaksi yang diizinkan hanya oleh reset.',[[{text:'Buka switch tanpa reset budget',callback_data:`confirm:${t}`}]]);}
        else{await storage.setKill(false,'Owner reset; budgets retained',c.store.fence());await c.send('Switch dibuka. Budget dan reservasi ambigu tetap dipertahankan.');}
      } else if(p[1]==='execute'&&p.length===3){
        if(!c.confirmed||!/^\w{32}$/.test(p[2]))throw new Error('Eksekusi wajib melalui tombol konfirmasi quote; bukan perintah chat.');
        if(!await storage.confirm(p[2],c,c.updateId,c.store.fence()))throw new Error('Quote kedaluwarsa, berubah, sudah diklaim, atau bukan milik actor/chat ini.');
        await c.send('Konfirmasi order tersimpan. Executor terpisah masih memeriksa risk budget, audit fresh, calldata, signer, simulasi, fee dan expiry. Ini belum berarti transaksi terkirim.');
      } else if(p.length===1){
        const [rows,risk]=await Promise.all([storage.list(c),storage.risk()]);
        await c.send(`<b>Trading</b>\nLive: ${process.env.TRADE_LIVE_ENABLED==='true'?'konfigurasi enabled':'OFF'}\nKill: ${risk.killed}\n${escapeHtml(risk.reason??'')}\nBudget at-risk terpakai: $${risk.usedUsd}; bukan kerugian PnL terukur. Budget tidak direfund otomatis.\n${rows.map(o=>`${o.id}: ${o.status}${o.txHash?` | tx ${escapeHtml(o.txHash)}`:''}`).join('\n')||'Belum ada order.'}`);
      } else throw new Error('Gunakan /trade, /trade kill, atau /trade reset.');
    }
  } catch(error){await c.send(`Operasi tidak dijalankan: ${escapeHtml(error instanceof Error?error.message:'data tidak tersedia')}`);}
  return true;
}
