/**
 * Seed wallet addresses into the database.
 * Usage: node scripts/seedWallets.js
 *
 * Edit WALLETS array below with your real deposit addresses before running.
 */

require('dotenv').config({ path: '.env.dev' });
const mongoose = require('mongoose');
const WalletAddress = require('../src/models/walletAddress.model');

const WALLETS = [
  // USDT TRC20
  { coin: 'USDT', network: 'TRC20', address: 'REPLACE_WITH_REAL_USDT_TRC20_ADDRESS_1' },
  { coin: 'USDT', network: 'TRC20', address: 'REPLACE_WITH_REAL_USDT_TRC20_ADDRESS_2' },
  { coin: 'USDT', network: 'TRC20', address: 'REPLACE_WITH_REAL_USDT_TRC20_ADDRESS_3' },

  // BTC
  { coin: 'BTC', network: 'Bitcoin', address: 'REPLACE_WITH_REAL_BTC_ADDRESS_1' },
  { coin: 'BTC', network: 'Bitcoin', address: 'REPLACE_WITH_REAL_BTC_ADDRESS_2' },

  // ETH ERC20
  { coin: 'ETH', network: 'ERC20', address: 'REPLACE_WITH_REAL_ETH_ADDRESS_1' },
  { coin: 'ETH', network: 'ERC20', address: 'REPLACE_WITH_REAL_ETH_ADDRESS_2' },

  // BNB BEP20
  { coin: 'BNB', network: 'BEP20 (BSC)', address: 'REPLACE_WITH_REAL_BNB_ADDRESS_1' },

  // SOL
  { coin: 'SOL', network: 'Solana', address: 'REPLACE_WITH_REAL_SOL_ADDRESS_1' },
];

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  let inserted = 0;
  let skipped = 0;

  for (const wallet of WALLETS) {
    const exists = await WalletAddress.findOne({ address: wallet.address });
    if (exists) {
      console.log(`  SKIP (already exists): ${wallet.coin} ${wallet.address.slice(0, 12)}…`);
      skipped++;
      continue;
    }
    await WalletAddress.create({ ...wallet, isAvailable: true });
    console.log(`  ADDED: ${wallet.coin} (${wallet.network}) ${wallet.address.slice(0, 12)}…`);
    inserted++;
  }

  console.log(`\nDone — ${inserted} added, ${skipped} skipped.`);
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
