import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const contract_address = searchParams.get('contract_address');
  const chain_network = searchParams.get('chain_network'); 
  const price_usd = Number(searchParams.get('price_usd') || 0);

  if (!contract_address || !chain_network) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  const chain = chain_network.toLowerCase();

  try {
    // 1. SOLANA LOGIC (Helius RPC)
    if (chain === 'solana') {
      const heliusKey = process.env.HELIUS_API_KEY;
      
      if (!heliusKey) {
        return NextResponse.json({ error: 'API Key Helius belum dikonfigurasi. Silakan tambahkan HELIUS_API_KEY.' }, { status: 500 });
      }

      const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`);
      let mintPubkey: PublicKey;
      
      try {
        mintPubkey = new PublicKey(contract_address);
      } catch (e) {
        return NextResponse.json({ error: 'Invalid Solana contract address' }, { status: 400 });
      }

      // Get largest token accounts
      let largestAccounts;
      try {
        largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
      } catch (rpcError: any) {
        if (rpcError.message?.includes('32001') || rpcError.message?.includes('Too many requests')) {
          return NextResponse.json({ error: 'Terlalu banyak request. Node publik tidak kuat. Hubungi admin.' }, { status: 503 });
        }
        throw rpcError;
      }
      
      const accounts = largestAccounts.value.slice(0, 10); // Top 10

      // We need to find the OWNER of these token accounts
      const holders = [];
      let totalSupplyRaw = 0;

      try {
        const supplyInfo = await connection.getTokenSupply(mintPubkey);
        totalSupplyRaw = Number(supplyInfo.value.amount);
      } catch(e) {}

      for (const account of accounts) {
        try {
          const accountInfo = await connection.getParsedAccountInfo(account.address);
          const parsedData = (accountInfo.value?.data as any)?.parsed?.info;
          const ownerAddress = parsedData?.owner;

          if (ownerAddress) {
            let share = 0;
            const balanceStr = account.amount;
            if (totalSupplyRaw > 0) {
              share = (Number(balanceStr) / totalSupplyRaw) * 100;
            }
            
            const balanceFmt = account.uiAmount || 0;
            holders.push({
              address: ownerAddress,
              balance: balanceFmt,
              value_usd: balanceFmt * price_usd,
              share: share > 0 ? Number(share.toFixed(2)) : 0
            });
          }
        } catch (e) {
          console.error(`Failed to parse owner for token account ${account.address.toBase58()}`, e);
        }
      }

      return NextResponse.json({ holders });
    }
    // 2. EVM LOGIC (Covalent API)
    else {
      let chainId = 1; // Default to Ethereum
      if (chain === 'bsc' || chain === 'binance') chainId = 56;
      else if (chain === 'base chain' || chain === 'base') chainId = 8453;
      else if (chain === 'robinhood' || chain.includes('robinhood') || chain === 'rh') chainId = 4663;
      else if (chain === 'polygon' || chain === 'matic') chainId = 137;
      else if (chain === 'arbitrum') chainId = 42161;
      else if (chain === 'optimism') chainId = 10;
      
      const covalentKey = process.env.COVALENT_API_KEY;
      if (!covalentKey) {
        return NextResponse.json({ error: 'Missing COVALENT_API_KEY env variable' }, { status: 500 });
      }

      // Use V2 endpoint without page-size to avoid timeouts on popular BSC tokens
      const covalentUrl = `https://api.covalenthq.com/v1/${chainId}/tokens/${contract_address}/token_holders_v2/?key=${covalentKey}`;
      
      const response = await axios.get(covalentUrl);
      const items = (response.data?.data?.items || []).slice(0, 10); // Ambil 10 teratas

      const holders = items.map((item: any) => {
        // Covalent returns raw balance string
        const decimals = item.contract_decimals || 18;
        let balanceFormatted = 0;
        let shareCalculated = 0;
        
        try {
          const bal = BigInt(item.balance);
          const totalSupply = BigInt(item.total_supply || '0');
          balanceFormatted = Number(bal) / (10 ** decimals);
          
          if (totalSupply > BigInt(0)) {
            const totalSupplyFormatted = Number(totalSupply) / (10 ** decimals);
            shareCalculated = (balanceFormatted / totalSupplyFormatted) * 100;
            if (shareCalculated > 100) shareCalculated = 100; // Cap at 100% if Covalent data is glitchy
          }
        } catch(e) {
          balanceFormatted = 0;
        }

        return {
          address: item.address,
          balance: balanceFormatted,
          value_usd: balanceFormatted * price_usd,
          share: Number(shareCalculated.toFixed(2))
        };
      });

      return NextResponse.json({ holders });
    }

  } catch (error: any) {
    console.error('Error fetching holders:', error.response?.data || error.message);
    return NextResponse.json({ error: error.response?.data?.error_message || error.message || 'Internal server error' }, { status: 500 });
  }
}

