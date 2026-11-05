'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { 
  History, 
  X, 
  ExternalLink, 
  Loader2, 
  RefreshCw, 
  ArrowUpRight, 
  ArrowDownRight, 
  Copy, 
  Check, 
  Filter, 
  TrendingUp, 
  TrendingDown, 
  Scale, 
  Activity 
} from 'lucide-react';
import { formatCurrency, formatTokenPrice, truncateAddress, formatCompactNumber } from '@/app/lib/utils';

interface Trade {
  id: string;
  type: 'buy' | 'sell';
  priceUsd: number;
  tokenAmount: number;
  volumeUsd: number;
  timestamp: string;
  txHash: string;
  maker: string;
}

interface TradeStats {
  totalTrades: number;
  buyCount: number;
  sellCount: number;
  totalBuyVolumeUsd: number;
  totalSellVolumeUsd: number;
  netFlowUsd: number;
}

interface PoolInfo {
  address: string;
  name: string;
  network: string;
  fdv_usd?: string;
  market_cap_usd?: string;
}

interface TradeHistoryModalProps {
  coin: {
    contract_address: string;
    chain_network?: string;
    chain_id?: string;
    label?: string;
    name?: string;
    symbol?: string;
    logo?: string | null;
  };
}

export default function TradeHistoryModal({ coin }: TradeHistoryModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // UI Filters
  const [filterType, setFilterType] = useState<'all' | 'buy' | 'sell' | 'whale'>('all');
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const effectiveChain = coin.chain_network || coin.chain_id || 'solana';

  const fetchTrades = async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        contract_address: coin.contract_address,
        chain_network: effectiveChain
      });

      const res = await fetch(`/api/trades?${query.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP Error: ${res.status}`);
      }

      const json = await res.json();
      if (json.error && (!json.trades || json.trades.length === 0)) {
        setError(json.error);
        setTrades([]);
        setStats(null);
        setPool(null);
      } else {
        setTrades(json.trades || []);
        setStats(json.stats || null);
        setPool(json.pool || null);
      }
    } catch (err: any) {
      console.error('Failed to fetch trades:', err);
      setError('Gagal memuat riwayat transaksi. Silakan coba kembali.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchTrades();
    }
  }, [isOpen, coin.contract_address, effectiveChain]);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const getTxExplorerUrl = (txHash: string): string => {
    const net = (effectiveChain || '').toUpperCase();
    if (net.includes('SOL')) return `https://solscan.io/tx/${txHash}`;
    if (net.includes('BASE')) return `https://basescan.org/tx/${txHash}`;
    if (net.includes('BSC') || net.includes('BNB')) return `https://bscscan.com/tx/${txHash}`;
    if (net.includes('ROBINHOOD') || net.includes('RH')) return `https://explorer.robinhood.com/tx/${txHash}`;
    if (net.includes('POLY')) return `https://polygonscan.com/tx/${txHash}`;
    if (net.includes('ARB')) return `https://arbiscan.io/tx/${txHash}`;
    return `https://etherscan.io/tx/${txHash}`;
  };

  const getAddressExplorerUrl = (address: string): string => {
    const net = (effectiveChain || '').toUpperCase();
    if (net.includes('SOL')) return `https://solscan.io/account/${address}`;
    if (net.includes('BASE')) return `https://basescan.org/address/${address}`;
    if (net.includes('BSC') || net.includes('BNB')) return `https://bscscan.com/address/${address}`;
    if (net.includes('ROBINHOOD') || net.includes('RH')) return `https://explorer.robinhood.com/address/${address}`;
    return `https://etherscan.io/address/${address}`;
  };

  const formatRelativeTime = (isoString: string): string => {
    try {
      const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
      if (diffSec < 60) return `${diffSec}s ago`;
      const mins = Math.floor(diffSec / 60);
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    } catch {
      return isoString;
    }
  };

  // Filtered trades
  const filteredTrades = useMemo(() => {
    if (filterType === 'buy') return trades.filter(t => t.type === 'buy');
    if (filterType === 'sell') return trades.filter(t => t.type === 'sell');
    if (filterType === 'whale') return trades.filter(t => t.volumeUsd >= 100);
    return trades;
  }, [trades, filterType]);

  const displayName = coin.symbol || coin.label || coin.name || 'Token';

  return (
    <>
      <button 
        onClick={() => setIsOpen(true)} 
        className="px-3 py-1.5 rounded-lg bg-purple-50 hover:bg-purple-100 text-purple-700 font-semibold text-xs flex items-center gap-1.5 transition-colors border border-purple-200/60 shadow-2xs"
        title="View Live On-chain DEX Transactions"
      >
        <Activity size={13} className="text-purple-600" />
        <span>Transactions</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col border border-slate-200 overflow-hidden">
            
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/80 backdrop-blur">
              <div className="flex items-center gap-3">
                {coin.logo ? (
                  <img src={coin.logo} alt={displayName} className="w-10 h-10 rounded-full object-cover border border-slate-200 shadow-xs" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center font-bold text-sm">
                    {displayName.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold text-slate-900">
                      Live Transactions — {displayName}
                    </h2>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-purple-100 text-purple-700 uppercase">
                      {pool?.name || effectiveChain}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="font-mono text-xs text-slate-500">{truncateAddress(coin.contract_address, 10, 6)}</span>
                    <button 
                      onClick={() => handleCopy(coin.contract_address)} 
                      className="text-slate-400 hover:text-slate-700 transition-colors"
                      title="Copy contract address"
                    >
                      {copiedText === coin.contract_address ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                    </button>
                    {pool?.address && (
                      <a 
                        href={`https://www.geckoterminal.com/${pool.network}/pools/${pool.address}`}
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 font-medium ml-2"
                      >
                        GeckoTerminal <ExternalLink size={11} />
                      </a>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={fetchTrades}
                  disabled={loading}
                  className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-200/60 rounded-lg transition-colors"
                  title="Refresh transactions"
                >
                  <RefreshCw size={16} className={loading ? "animate-spin text-purple-600" : ""} />
                </button>
                <button 
                  onClick={() => setIsOpen(false)} 
                  className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-lg transition-colors"
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-6">
              
              {/* Stats Bar */}
              {stats && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
                  <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3.5 shadow-xs">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                      <Activity size={14} className="text-slate-400" />
                      <span>Total Transactions</span>
                    </div>
                    <div className="text-lg font-bold text-slate-900 mt-1">
                      {stats.totalTrades} <span className="text-xs font-normal text-slate-500">trades</span>
                    </div>
                  </div>

                  <div className="bg-emerald-50/70 border border-emerald-200/80 rounded-xl p-3.5 shadow-xs">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                      <TrendingUp size={14} />
                      <span>Buy Volume ({stats.buyCount})</span>
                    </div>
                    <div className="text-lg font-bold text-emerald-700 mt-1">
                      {formatCurrency(stats.totalBuyVolumeUsd)}
                    </div>
                  </div>

                  <div className="bg-rose-50/70 border border-rose-200/80 rounded-xl p-3.5 shadow-xs">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-700">
                      <TrendingDown size={14} />
                      <span>Sell Volume ({stats.sellCount})</span>
                    </div>
                    <div className="text-lg font-bold text-rose-700 mt-1">
                      {formatCurrency(stats.totalSellVolumeUsd)}
                    </div>
                  </div>

                  <div className={`border rounded-xl p-3.5 shadow-xs ${
                    stats.netFlowUsd >= 0 
                      ? 'bg-emerald-50/40 border-emerald-200 text-emerald-700' 
                      : 'bg-rose-50/40 border-rose-200 text-rose-700'
                  }`}>
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <Scale size={14} />
                      <span>Net Flow</span>
                    </div>
                    <div className="text-lg font-bold mt-1">
                      {stats.netFlowUsd >= 0 ? '+' : ''}{formatCurrency(stats.netFlowUsd)}
                    </div>
                  </div>
                </div>
              )}

              {/* Filter Tabs & Counter */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-lg border border-slate-200 text-xs font-semibold">
                  <button
                    onClick={() => setFilterType('all')}
                    className={`px-3 py-1 rounded-md transition-all ${
                      filterType === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    All ({trades.length})
                  </button>
                  <button
                    onClick={() => setFilterType('buy')}
                    className={`px-3 py-1 rounded-md transition-all flex items-center gap-1 ${
                      filterType === 'buy' ? 'bg-emerald-600 text-white shadow-xs' : 'text-emerald-700 hover:bg-emerald-50'
                    }`}
                  >
                    <ArrowUpRight size={13} /> Buys ({stats?.buyCount || 0})
                  </button>
                  <button
                    onClick={() => setFilterType('sell')}
                    className={`px-3 py-1 rounded-md transition-all flex items-center gap-1 ${
                      filterType === 'sell' ? 'bg-rose-600 text-white shadow-xs' : 'text-rose-700 hover:bg-rose-50'
                    }`}
                  >
                    <ArrowDownRight size={13} /> Sells ({stats?.sellCount || 0})
                  </button>
                  <button
                    onClick={() => setFilterType('whale')}
                    className={`px-3 py-1 rounded-md transition-all flex items-center gap-1 ${
                      filterType === 'whale' ? 'bg-purple-600 text-white shadow-xs' : 'text-purple-700 hover:bg-purple-50'
                    }`}
                  >
                    🐋 Whale (&gt;$100)
                  </button>
                </div>

                <span className="text-xs text-slate-500 font-medium">
                  Showing {filteredTrades.length} recent transactions
                </span>
              </div>

              {/* Trades Table */}
              {loading ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
                  <Loader2 size={36} className="animate-spin text-purple-600" />
                  <p className="text-sm font-medium">Fetching real-time DEX transactions...</p>
                </div>
              ) : error ? (
                <div className="text-center py-10 px-4 text-rose-600 bg-rose-50/80 rounded-xl border border-rose-200">
                  <p className="font-semibold text-sm">{error}</p>
                  <button 
                    onClick={fetchTrades} 
                    className="mt-3 px-4 py-1.5 bg-rose-600 text-white text-xs font-semibold rounded-lg hover:bg-rose-700 transition-colors shadow-xs"
                  >
                    Retry
                  </button>
                </div>
              ) : filteredTrades.length === 0 ? (
                <div className="text-center py-12 text-slate-500 bg-slate-50 rounded-xl border border-slate-200">
                  <History size={32} className="mx-auto text-slate-400 mb-2 opacity-60" />
                  <p className="font-semibold text-sm">No transactions found for this filter.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-xs bg-white">
                  <table className="w-full text-xs text-left">
                    <thead className="text-[11px] font-bold text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-4 py-3">Type</th>
                        <th className="px-4 py-3">Price (USD)</th>
                        <th className="px-4 py-3">Token Amount</th>
                        <th className="px-4 py-3">Volume USD</th>
                        <th className="px-4 py-3">Trader / Maker</th>
                        <th className="px-4 py-3">Time</th>
                        <th className="px-4 py-3 text-right">Tx Hash</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono text-[12px]">
                      {filteredTrades.map((trade) => {
                        const isBuy = trade.type === 'buy';
                        return (
                          <tr key={trade.id} className="hover:bg-slate-50/80 transition-colors">
                            {/* Type Badge */}
                            <td className="px-4 py-3 font-sans">
                              <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-bold text-[11px] uppercase tracking-wide ${
                                isBuy 
                                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-200/60' 
                                  : 'bg-rose-100 text-rose-800 border border-rose-200/60'
                              }`}>
                                {isBuy ? <ArrowUpRight size={13} className="text-emerald-700" /> : <ArrowDownRight size={13} className="text-rose-700" />}
                                {trade.type}
                              </span>
                            </td>

                            {/* Price USD */}
                            <td className="px-4 py-3 font-semibold text-slate-800">
                              {formatTokenPrice(trade.priceUsd).replace('@ ', '')}
                            </td>

                            {/* Token Amount */}
                            <td className="px-4 py-3 text-slate-700">
                              {formatCompactNumber(trade.tokenAmount, { decimals: 2, roundCeil: true })}
                            </td>

                            {/* Volume USD */}
                            <td className={`px-4 py-3 font-bold ${
                              trade.volumeUsd >= 500 
                                ? 'text-purple-700 font-extrabold' 
                                : isBuy ? 'text-emerald-700' : 'text-rose-700'
                            }`}>
                              {formatCurrency(trade.volumeUsd)}
                            </td>

                            {/* Maker / Trader */}
                            <td className="px-4 py-3 text-slate-500 font-mono">
                              <div className="flex items-center gap-1.5">
                                <a 
                                  href={getAddressExplorerUrl(trade.maker)} 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  className="hover:text-blue-600 transition-colors"
                                  title={trade.maker}
                                >
                                  {truncateAddress(trade.maker, 4, 4)}
                                </a>
                                <button 
                                  onClick={() => handleCopy(trade.maker)} 
                                  className="text-slate-300 hover:text-slate-600 transition-colors"
                                  title="Copy address"
                                >
                                  {copiedText === trade.maker ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
                                </button>
                              </div>
                            </td>

                            {/* Timestamp */}
                            <td className="px-4 py-3 text-slate-500 font-sans" title={new Date(trade.timestamp).toLocaleString('en-US')}>
                              {formatRelativeTime(trade.timestamp)}
                            </td>

                            {/* Tx Explorer */}
                            <td className="px-4 py-3 text-right font-sans">
                              <a 
                                href={getTxExplorerUrl(trade.txHash)} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 font-semibold transition-colors bg-blue-50 px-2 py-0.5 rounded-md hover:bg-blue-100"
                              >
                                View <ExternalLink size={11} />
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3.5 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between text-xs text-slate-500">
              <span>Data powered by GeckoTerminal Real-time DEX API</span>
              <button 
                onClick={() => setIsOpen(false)} 
                className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg font-semibold transition-colors"
              >
                Close
              </button>
            </div>

          </div>
        </div>
      )}
    </>
  );
}
