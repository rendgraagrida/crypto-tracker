export type TradeActor = { userId: string; chatId: string };
export type TradeFence = { jobId: string; attempt: number };
export type SwapRequest = {
  chain: string;
  inputToken: string;
  outputToken: string;
  amountRaw: string;
  taker: string;
  slippageBps: number;
};
export type ApiInstruction = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};
export type SolanaBuild = {
  kind: 'solana';
  computeBudgetInstructions: ApiInstruction[];
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  addressesByLookupTableAddress: Record<string, string[]>;
  blockhash: string;
  lastValidBlockHeight: number;
};
export type EvmBuild = {
  kind: 'evm';
  chainId: number;
  to: string;
  data: string;
  value: string;
  gas: string;
  gasPrice: string;
  allowance: { spender: string; actualRaw: string; requiredRaw: string } | null;
};
export type SwapQuote = SwapRequest & {
  provider: 'jupiter-v2' | '0x-v2';
  amountOutRaw: string;
  minOutRaw: string;
  priceImpactBps: number | null;
  feeNativeRaw: string | null;
  feesDescription: string;
  createdAt: string;
  expiresAt: string;
  build: SolanaBuild | EvmBuild;
};
export type TradeOrder = {
  id: string;
  actor: TradeActor;
  quote: SwapQuote;
  mode: 'manual' | 'auto';
  notionalUsd: string;
  status: 'quoted' | 'confirmed' | 'executing' | 'signed' | 'submitted' | 'confirmed_onchain' | 'failed' | 'expired' | 'unknown';
  confirmedUpdateId: number | null;
  txHash: string | null;
  signedPayload: string | null;
  error: string | null;
};
