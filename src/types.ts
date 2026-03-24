export type Network = 'ethereum' | 'polygon' | 'base' | 'arbitrum' | 'optimism';

export interface MintParams {
  contractAddress: string;
  network: Network;
  functionName: string;
  args: string[];
  mintPrice: string; // in ETH/Native
  quantity: number;
  gasPreference: 'low' | 'standard' | 'aggressive';
  scheduledTime?: Date;
}

export interface WalletStatus {
  address: string;
  balance: string;
  status: 'idle' | 'preparing' | 'simulating' | 'executing' | 'confirmed' | 'failed';
  txHash?: string;
  error?: string;
}

export interface MintLog {
  id: string;
  timestamp: Date;
  wallet: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}
