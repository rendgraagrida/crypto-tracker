export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// 🟢 Import mesin pembaca Solana
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'; 

// Lazy initialization Supabase agar aman dari crash saat Docker build time
function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
}

// Adaptor Jaringan EVM (Khusus Moralis)
const getMoralisChain = (network: string) => {
  const net = network.toUpperCase();
  if (net === 'ETHEREUM' || net.includes('EVM')) return 'eth';
  if (net === 'BASE CHAIN') return 'base';
  if (net === 'BSC') return 'bsc';
  return null;
};

export async function GET() {
  try {
    const supabase = getSupabase();
    if (!supabase) return NextResponse.json([], { status: 200 });

    const { data, error } = await supabase.from('watchlist').select('*').order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    
    const wallets = data || [];
    const moralisApiKey = process.env.MORALIS_API_KEY || '';
    
    // ==========================================
    // 🔴 RADAR LIVE HYBRID (EVM + SOLANA)
    // ==========================================
    const walletsWithLiveBalance = await Promise.all(wallets.map(async (wallet) => {
      let liveBalance = "0.0000";
      const safeNet = wallet.chain_network.toUpperCase();
      const moralisChain = getMoralisChain(safeNet);
      
      try {
        if (moralisChain && moralisApiKey) {
          // MESIN 1: Menembak EVM menggunakan Moralis
          const url = `https://deep-index.moralis.io/api/v2.2/${wallet.wallet_address}/balance?chain=${moralisChain}`;
          const res = await fetch(url, { 
            headers: { "Accept": "application/json", "X-API-Key": moralisApiKey } 
          });
          
          if (res.ok) {
            const bData = await res.json();
            if (bData.balance) liveBalance = (Number(bData.balance) / 1e18).toFixed(4);
          }
        } else if (safeNet === 'SOLANA') {
          // MESIN 2: Menembak Solana menggunakan Alchemy RPC + Web3.js
          const rpcUrl = process.env.ALCHEMY_SOL_URL || 'https://api.mainnet-beta.solana.com';
          const solanaConnection = new Connection(rpcUrl, 'confirmed');
          const pubKey = new PublicKey(wallet.wallet_address);
          const balanceLamports = await solanaConnection.getBalance(pubKey);
          liveBalance = (balanceLamports / LAMPORTS_PER_SOL).toFixed(4);
        }
      } catch (e) {
        console.error(`[RADAR ERROR] Gagal melacak ${wallet.wallet_address}:`, e);
        liveBalance = "ERR_RPC";
      }
      
      return { ...wallet, balance: liveBalance };
    }));

    return NextResponse.json(walletsWithLiveBalance);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return NextResponse.json({ error: "Database belum terkonfigurasi" }, { status: 500 });
    }

    const { wallet_address, chain_network, label } = await request.json();
    if (!wallet_address || !chain_network) {
      return NextResponse.json({ error: "Data dompet tidak lengkap" }, { status: 400 });
    }

    const safeAddress = wallet_address.toString().trim();
    const net = chain_network.toUpperCase();
    const walletLabel = label || "Unknown Target";
    
    // 🔴 ZERO TRUST GUARD: Memastikan dompet Solana bukan alamat asal-asalan
    if (net === 'SOLANA') {
      try {
        new PublicKey(safeAddress);
      } catch (err) {
        return NextResponse.json({ error: "Format alamat Solana (Base58) TIDAK VALID! Pastikan tidak salah copy." }, { status: 400 });
      }
    }

    let networksToInsert = [chain_network];
    if (net.includes('EVM')) {
      networksToInsert = ['Ethereum', 'BSC', 'Base Chain'];
    }

    const insertData = networksToInsert.map(network => ({
      wallet_address: safeAddress,
      chain_network: network,
      label: walletLabel
    }));

    const { data, error } = await supabase.from('watchlist').insert(insertData);

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: "Target ini sudah ada di dalam Watchlist!" }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return NextResponse.json({ error: "Database belum terkonfigurasi" }, { status: 500 });
    }

    const { wallet_address, chain_network, deleteAll } = await request.json();
    
    if (deleteAll) {
      const { error } = await supabase.from('watchlist').delete().neq('wallet_address', '');
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    const { error } = await supabase
      .from('watchlist')
      .delete()
      .match({ 
        wallet_address: wallet_address.toString().trim(), 
        chain_network: chain_network 
      });

    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return NextResponse.json({ error: "Database belum terkonfigurasi" }, { status: 500 });
    }

    const body = await request.json();
    const { wallet_address, chain_network, label, is_primary } = body;
    if (!wallet_address || !chain_network) {
      return NextResponse.json({ error: "Data dompet tidak lengkap" }, { status: 400 });
    }

    const safeAddress = wallet_address.toString().trim();

    // Handle is_primary toggle separately
    if (is_primary !== undefined) {
      // Enforce max 5 primary wallets
      if (is_primary === true) {
        const { data: existing } = await supabase
          .from('watchlist')
          .select('wallet_address')
          .eq('is_primary', true);

        const currentPrimary = (existing || []).filter(
          (w: any) => w.wallet_address.toLowerCase() !== safeAddress.toLowerCase()
        );

        if (currentPrimary.length >= 5) {
          return NextResponse.json({
            error: 'Maksimal 5 wallet utama. Lepas pin dari wallet lain terlebih dahulu.',
            limitReached: true
          }, { status: 400 });
        }
      }

      // Toggle is_primary for ALL network rows of this wallet
      const { error } = await supabase
        .from('watchlist')
        .update({ is_primary: is_primary === true })
        .eq('wallet_address', safeAddress);

      if (error) throw error;
      return NextResponse.json({ success: true, is_primary: is_primary === true });
    }

    // Handle label update
    const newLabel = (label || "Unknown Target").trim();
    const { data, error } = await supabase
      .from('watchlist')
      .update({ label: newLabel })
      .match({ 
        wallet_address: safeAddress, 
        chain_network: chain_network 
      });

    if (error) throw error;
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}