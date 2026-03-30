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
  contractType?: 'seadrop' | 'thirdweb' | 'generic';
  mintFunction?: string;

  // Price
  price?: string;
  priceWei?: string;

  // Supply
  totalSupply?: number;
  maxSupply?: number;

  // State
  isPaused?: boolean;
  currentPhase?: string;

  // Quantity limits
  minQuantity?: number;
  maxQuantity?: number;

  // Gas
  gasInfo?: GasInfo;

  // SeaDrop
  isSeaDrop?: boolean;
  seaDropAddress?: string;
  seaDropFeeRecipient?: string;

  // ThirdWeb
  thirdwebConditionId?: string;
  thirdwebCondition?: any;
}
