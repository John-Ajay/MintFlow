export type Network = 'ethereum' | 'polygon' | 'base' | 'arbitrum' | 'optimism';

export interface MintParams {
  contractAddress: string;
  network: Network;
  functionName: string;
  args: any[];
  mintPrice: string;
  quantity: number;
  gasPreference: 'low' | 'standard' | 'aggressive';
  manualAbi: string;
}

export interface WalletStatus {
  address: string;
  balance: string;
  status: 'idle' | 'preparing' | 'simulating' | 'executing' | 'confirmed' | 'failed' | 'skipped';
  txHash?: string;
  gasUsed?: string;
  error?: string;
}

export interface MintLog {
  id: string;
  timestamp: Date;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
  wallet?: string;
}

export interface GasInfo {
  baseFeeGwei: string;
  priorityFeeGwei: string;
  totalGwei: string;
}

export interface ContractInfo {
  address: string;
  abi: any[];
  isVerified: boolean;
  mintFunction?: string;

  // Price
  price?: string;        // formatted ETH/POL string
  priceWei?: string;     // raw wei string for display

  // Supply
  totalSupply?: number;
  maxSupply?: number;

  // State
  isPaused?: boolean;
  currentPhase?: string; // e.g. "Public Sale", "Presale", "Phase 2"

  // Quantity limits
  minQuantity?: number;
  maxQuantity?: number;

  // Live gas
  gasInfo?: GasInfo;
}
