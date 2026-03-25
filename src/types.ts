export type Network = 'ethereum' | 'polygon' | 'base' | 'arbitrum' | 'optimism';

export interface ContractInfo {
  address: string;
  abi: any[];
  isVerified: boolean;
  mintFunction?: string;
  price?: string;
  maxSupply?: number;
  totalSupply?: number;
  isPaused?: boolean;
}

export interface MintParams {
  contractAddress: string;
  network: Network;
  functionName: string;
  args: any[];
  mintPrice: string;
  quantity: number;
  gasPreference: 'low' | 'standard' | 'aggressive';
  manualAbi?: string;
}

export interface WalletStatus {
  address: string;
  balance: string;
  status: 'idle' | 'preparing' | 'simulating' | 'executing' | 'confirmed' | 'failed' | 'skipped';
  txHash?: string;
  error?: string;
  gasUsed?: string;
}

export interface MintLog {
  id: string;
  timestamp: Date;
  wallet: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}
