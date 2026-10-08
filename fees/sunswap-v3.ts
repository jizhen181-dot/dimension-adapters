import ADDRESSES from "../helpers/coreAssets.json";
import { Adapter, FetchOptions, } from "../adapters/types";
import { CHAIN } from "../helpers/chains";
import { httpGet } from "../utils/fetchURL";

const api = "https://openapi.sun.io/open/api/feeData"
interface IResponse {
  date: number;
  fee:  number;
}

// Protocol fee (Uniswap V3 fee switch): the protocol keeps 1/feeProtocol of the swap fee.
// Only enabled on the WTRX/USDT 0.05% pool: SetFeeProtocol 0 -> 6 at 2026-05-02 09:31:57 UTC
// tx: https://tronscan.org/#/transaction/be346d97b780a1c016df2df8d5b594b2ca6bf41b98fac41a4d634bd69cd23976
const PROTOCOL_FEE_POOL = "TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx"; // WTRX/USDT
const PROTOCOL_FEE_ENABLED_AT = 1777714317;
const SWAP_FEE = 500 / 1e6; // pool fee tier 0.05%
const FEE_PROTOCOL = 6;

const SWAP_FEES = "Swap Fees";
const SWAP_FEES_TO_LPS = "Swap Fees To LPs";
const SWAP_FEES_TO_PROTOCOL = "Swap Fees To Protocol";

// Protocol fee = amountIn * 0.05% / 6 for each Swap event of the pool, read from TronGrid (paginated, same as fees/justlend.ts).
async function getProtocolFeesUSD(options: FetchOptions) {
  const dayEnd = options.startOfDay + 86400;
  const from = Math.max(options.startOfDay, PROTOCOL_FEE_ENABLED_AT);
  if (from >= dayEnd) return 0;
  const balances = options.createBalances();
  let fingerprint: string | undefined;
  for (let page = 0; page < 500; page++) {
    let url = `https://api.trongrid.io/v1/contracts/${PROTOCOL_FEE_POOL}/events?event_name=Swap&only_confirmed=true&min_block_timestamp=${from * 1000}&max_block_timestamp=${dayEnd * 1000 - 1}&order_by=block_timestamp,asc&limit=200`;
    if (fingerprint) url += `&fingerprint=${fingerprint}`;
    const res = await httpGet(url);
    if (!res?.success) throw new Error(`TronGrid error for ${PROTOCOL_FEE_POOL}`);
    for (const ev of res.data ?? []) {
      const amount0 = BigInt(ev.result.amount0);
      const amount1 = BigInt(ev.result.amount1);
      if (amount0 > 0n) balances.add(ADDRESSES.tron.WTRX, Number(amount0) * SWAP_FEE / FEE_PROTOCOL);
      else if (amount1 > 0n) balances.add(ADDRESSES.tron.USDT, Number(amount1) * SWAP_FEE / FEE_PROTOCOL);
    }
    fingerprint = res.meta?.fingerprint;
    if (!fingerprint || !res.data?.length) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return balances.getUSDValue();
}

const adapter: Adapter = {
  version: 1,
  adapter: {
    [CHAIN.TRON]: {
      fetch: (async (options: FetchOptions) => {
        const start = options.startOfDay * 1000;
        const end = start + 86400;
        const startStr = new Date(start).toISOString().split("T")[0];
        const endStr = new Date(end).toISOString().split("T")[0];
        const url = `${api}?fromDate=${startStr}&toDate=${endStr}&version=v3`;
        const res: IResponse[] = (await httpGet(url)).data;
        if (!res || !res.length) throw new Error(`No fee data returned for date range ${startStr} - ${endStr}`);
        const dayItem = res.find((item) => item.date === start);
        if (!dayItem) throw new Error(`No fee data for date ${startStr}`);
        const dailyFees = dayItem.fee;
        const protocolFees = await getProtocolFeesUSD(options);
        const fees = options.createBalances();
        const revenue = options.createBalances();
        const supplySideRevenue = options.createBalances();
        fees.addUSDValue(dailyFees, SWAP_FEES);
        revenue.addUSDValue(protocolFees, SWAP_FEES_TO_PROTOCOL);
        supplySideRevenue.addUSDValue(dailyFees - protocolFees, SWAP_FEES_TO_LPS);
        return { dailyFees: fees, dailySupplySideRevenue: supplySideRevenue, dailyRevenue: revenue };
      }) as any,
      start: '2024-01-06'
    },
  },
  methodology: {
    Fees: 'Swap fees paid by users.',
    Revenue: 'Protocol share of swap fees: 1/6 of the swap fee on the WTRX/USDT pool since 2026-05-02.',
    SupplySideRevenue: 'Swap fees distributed to liquidity providers, after the protocol share.',
  },
  breakdownMethodology: {
    Fees: {
      [SWAP_FEES]: 'Swap fees paid by users on all SunSwap V3 pools.',
    },
    Revenue: {
      [SWAP_FEES_TO_PROTOCOL]: '1/6 of the swap fee on the WTRX/USDT pool since 2026-05-02.',
    },
    SupplySideRevenue: {
      [SWAP_FEES_TO_LPS]: 'Swap fees minus the protocol share.',
    },
  },
}

export default adapter;
