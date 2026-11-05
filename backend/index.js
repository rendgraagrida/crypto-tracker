require('dotenv').config(); 
const { ethers } = require('ethers');
const solanaWeb3 = require('@solana/web3.js');
const { createClient } = require('@supabase/supabase-js'); 

// 1. Membangun Jembatan ke Database Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 2. Membangun Jembatan Koneksi Blockchain (EVM + Solana)
const ethProvider = new ethers.JsonRpcProvider(process.env.ALCHEMY_ETH_URL);
const bscProvider = new ethers.JsonRpcProvider(process.env.ALCHEMY_BSC_URL);
const robinhoodProvider = new ethers.JsonRpcProvider(process.env.ALCHEMY_ROBINHOOD_URL);
// Jembatan baru untuk Base Chain
const baseProvider = new ethers.JsonRpcProvider(process.env.ALCHEMY_BASE_URL); 

const solanaConnection = new solanaWeb3.Connection(process.env.ALCHEMY_SOL_URL);

// 3. Menyiapkan Alamat Dompet Target
const evmTargetWallet = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; 
const solanaTargetWallet = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH"; 

// 4. Fungsi Khusus untuk Menyimpan ke Database
async function simpanKeWatchlist(wallet, network) {
    const { data: existingData } = await supabase
        .from('watchlist')
        .select('*')
        .eq('wallet_address', wallet)
        .eq('chain_network', network);

    if (existingData && existingData.length > 0) {
        console.log(`ℹ️ [Database] Dompet ${wallet} (${network}) sudah ada di Watchlist.`);
        return;
    }

    const { error } = await supabase
        .from('watchlist')
        .insert([
            { wallet_address: wallet, chain_network: network }
        ]);

    if (error) {
        console.error(`❌ [Database] Gagal menyimpan ${wallet} (${network}):`, error.message);
    } else {
        console.log(`✅ [Database] Berhasil menyimpan ${wallet} (${network}) ke Watchlist!`);
    }
}

// 5. Fungsi Utama Pelacakan
async function trackAllChains() {
    console.log(`\n🕵️ Memulai pelacakan multichain dan sinkronisasi database...`);
    console.log("---------------------------------------------------");

    try {
        // Mengambil Saldo EVM (Sekarang memasukkan Base Chain ke dalam antrean)
        const [ethBalance, bscBalance, robinhoodBalance, baseBalance] = await Promise.all([
            ethProvider.getBalance(evmTargetWallet),
            bscProvider.getBalance(evmTargetWallet),
            robinhoodProvider.getBalance(evmTargetWallet),
            baseProvider.getBalance(evmTargetWallet) // Menarik saldo Base secara bersamaan
        ]);

        // Mengambil Saldo Solana
        const solPubKey = new solanaWeb3.PublicKey(solanaTargetWallet);
        const solBalanceLamports = await solanaConnection.getBalance(solPubKey);
        const solBalance = solBalanceLamports / solanaWeb3.LAMPORTS_PER_SOL;

        // Cetak ke Terminal
        console.log(`[Target EVM]   : ${evmTargetWallet}`);
        console.log(`💰 Saldo ETH   : ${ethers.formatEther(ethBalance)} ETH`);
        console.log(`💰 Saldo BSC   : ${ethers.formatEther(bscBalance)} BNB`);
        console.log(`💰 Saldo RH    : ${ethers.formatEther(robinhoodBalance)} (Native Token)`);
        console.log(`💰 Saldo Base  : ${ethers.formatEther(baseBalance)} ETH\n`); // Hasil cetak saldo Base

        console.log(`[Target SOL]   : ${solanaTargetWallet}`);
        console.log(`💰 Saldo SOL   : ${solBalance} SOL`);
        console.log("---------------------------------------------------");

        // MENYIMPAN KE DATABASE SUPABASE SECARA SPESIFIK
        await simpanKeWatchlist(evmTargetWallet, 'Ethereum');
        await simpanKeWatchlist(evmTargetWallet, 'BSC');
        await simpanKeWatchlist(evmTargetWallet, 'Robinhood Chain');
        await simpanKeWatchlist(evmTargetWallet, 'Base Chain'); // Menyimpan identitas Base ke DB
        await simpanKeWatchlist(solanaTargetWallet, 'Solana');

    } catch (error) {
        console.error("❌ GAGAL melacak dompet:", error.message);
    }
}

trackAllChains();