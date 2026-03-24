import { ethers } from 'ethers';
import { MintParams, Network, WalletStatus } from '../types.ts';

const RPC_URLS: Record<Network, string> = {
  ethereum: 'https://eth.llamarpc.com',
  polygon: 'https://polygon.llamarpc.com',
  base: 'https://mainnet.base.org',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://mainnet.optimism.io',
};

export class MintEngine {
  private provider: ethers.JsonRpcProvider;
  private network: Network;

  constructor(network: Network) {
    this.network = network;
    this.provider = new ethers.JsonRpcProvider(RPC_URLS[network]);
  }

  async getBalance(address: string): Promise<string> {
    const balance = await this.provider.getBalance(address);
    return ethers.formatEther(balance);
  }

  async simulateMint(
    wallet: ethers.Wallet,
    params: MintParams
  ): Promise<{ success: boolean; error?: string; gasEstimate?: bigint }> {
    try {
      const connectedWallet = wallet.connect(this.provider);
      const abi = [`function ${params.functionName}(uint256 quantity) public payable`];
      const contract = new ethers.Contract(params.contractAddress, abi, connectedWallet);

      const value = ethers.parseEther((parseFloat(params.mintPrice) * params.quantity).toString());
      
      // Basic simulation using callStatic (in ethers v6 it's contract.function.staticCall)
      // For simplicity, we'll try to estimate gas as a proxy for simulation
      const gasEstimate = await contract[params.functionName].estimateGas(params.quantity, { value });
      
      return { success: true, gasEstimate };
    } catch (error: any) {
      console.error('Simulation failed:', error);
      return { success: false, error: error.message || 'Simulation failed' };
    }
  }

  async executeMint(
    privateKey: string,
    params: MintParams,
    onStatusUpdate: (status: Partial<WalletStatus>) => void
  ): Promise<string> {
    try {
      const wallet = new ethers.Wallet(privateKey, this.provider);
      const address = wallet.address;
      
      onStatusUpdate({ address, status: 'preparing' });
      
      const balance = await this.getBalance(address);
      onStatusUpdate({ balance });

      if (parseFloat(balance) < parseFloat(params.mintPrice) * params.quantity) {
        throw new Error('Insufficient funds');
      }

      onStatusUpdate({ status: 'simulating' });
      const sim = await this.simulateMint(wallet, params);
      if (!sim.success) {
        throw new Error(`Simulation failed: ${sim.error}`);
      }

      onStatusUpdate({ status: 'executing' });
      
      const abi = [`function ${params.functionName}(uint256 quantity) public payable`];
      const contract = new ethers.Contract(params.contractAddress, abi, wallet);
      const value = ethers.parseEther((parseFloat(params.mintPrice) * params.quantity).toString());

      // Gas strategy
      let feeData = await this.provider.getFeeData();
      let gasPrice = feeData.gasPrice;
      
      if (params.gasPreference === 'aggressive') {
        gasPrice = (gasPrice! * 150n) / 100n; // 50% increase
      } else if (params.gasPreference === 'standard') {
        gasPrice = (gasPrice! * 110n) / 100n; // 10% increase
      }

      const tx = await contract[params.functionName](params.quantity, {
        value,
        gasPrice,
        gasLimit: (sim.gasEstimate! * 120n) / 100n, // 20% buffer
      });

      onStatusUpdate({ txHash: tx.hash });
      
      const receipt = await tx.wait();
      onStatusUpdate({ status: 'confirmed' });
      
      return tx.hash;
    } catch (error: any) {
      onStatusUpdate({ status: 'failed', error: error.message || 'Unknown error' });
      throw error;
    }
  }
}
