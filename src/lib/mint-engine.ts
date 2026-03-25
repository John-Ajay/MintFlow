import { ethers } from 'ethers';
import { MintParams, Network, WalletStatus, ContractInfo } from '../types.ts';

const RPC_URLS: Record<Network, string[]> = {
  ethereum: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth', 'https://cloudflare-eth.com'],
  polygon: ['https://polygon.llamarpc.com', 'https://rpc-mainnet.matic.quiknode.pro', 'https://polygon-rpc.com'],
  base: ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://developer-access-mainnet.base.org'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com', 'https://rpc.ankr.com/arbitrum'],
  optimism: ['https://mainnet.optimism.io', 'https://optimism.llamarpc.com', 'https://rpc.ankr.com/optimism'],
};

export class MintEngine {
  private providers: ethers.JsonRpcProvider[];
  private currentProviderIndex: number = 0;
  private network: Network;

  constructor(network: Network) {
    this.network = network;
    this.providers = RPC_URLS[network].map(url => new ethers.JsonRpcProvider(url));
  }

  private get provider(): ethers.JsonRpcProvider {
    return this.providers[this.currentProviderIndex];
  }

  private async switchProvider() {
    this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
    console.warn(`Switching to fallback RPC provider: ${this.providers[this.currentProviderIndex].constructor.name}`);
  }

  private async callWithRetry<T>(fn: (provider: ethers.JsonRpcProvider) => Promise<T>, retries = 3): Promise<T> {
    let lastError: any;
    for (let i = 0; i < retries; i++) {
      try {
        return await fn(this.provider);
      } catch (error) {
        lastError = error;
        await this.switchProvider();
      }
    }
    throw lastError;
  }

  async getBalance(address: string): Promise<string> {
    return this.callWithRetry(async (p) => {
      const balance = await p.getBalance(address);
      return ethers.formatEther(balance);
    });
  }

  async analyzeContract(address: string, manualAbi?: string): Promise<ContractInfo> {
    return this.callWithRetry(async (p) => {
      let abi: any[] = [];
      if (manualAbi) {
        try {
          abi = JSON.parse(manualAbi);
        } catch (e) {
          throw new Error('Invalid manual ABI format');
        }
      } else {
        // Fallback to common minting ABI if Etherscan is not available or not used
        abi = [
          "function mint(uint256 quantity) public payable",
          "function publicMint(uint256 quantity) public payable",
          "function claim(address receiver, uint256 quantity) public payable",
          "function totalSupply() public view returns (uint256)",
          "function maxSupply() public view returns (uint256)",
          "function paused() public view returns (bool)",
          "function saleActive() public view returns (bool)",
          "function price() public view returns (uint256)"
        ];
      }

      const contract = new ethers.Contract(address, abi, p);
      const info: ContractInfo = { address, abi, isVerified: !!manualAbi };

      try {
        // Try to detect common fields
        const [totalSupply, maxSupply, paused, price] = await Promise.allSettled([
          contract.totalSupply(),
          contract.maxSupply(),
          contract.paused(),
          contract.price()
        ]);

        if (totalSupply.status === 'fulfilled') info.totalSupply = Number(totalSupply.value);
        if (maxSupply.status === 'fulfilled') info.maxSupply = Number(maxSupply.value);
        if (paused.status === 'fulfilled') info.isPaused = paused.value;
        if (price.status === 'fulfilled') info.price = ethers.formatEther(price.value);

        // Detect mint function
        const mintFunctions = ['mint', 'publicMint', 'claim', 'purchase'];
        for (const fn of mintFunctions) {
          if (contract[fn]) {
            info.mintFunction = fn;
            break;
          }
        }
      } catch (e) {
        console.warn('Contract analysis partial failure:', e);
      }

      return info;
    });
  }

  async simulateMint(
    wallet: ethers.Wallet,
    params: MintParams
  ): Promise<{ success: boolean; error?: string; gasEstimate?: bigint }> {
    try {
      const connectedWallet = wallet.connect(this.provider);
      const contract = new ethers.Contract(params.contractAddress, params.manualAbi ? JSON.parse(params.manualAbi) : [
        `function ${params.functionName}(uint256 quantity) public payable`
      ], connectedWallet);

      const value = ethers.parseEther((parseFloat(params.mintPrice) * params.quantity).toString());
      
      // Use staticCall for accurate simulation
      await contract[params.functionName].staticCall(params.quantity, { value });
      
      const gasEstimate = await contract[params.functionName].estimateGas(params.quantity, { value });
      
      return { success: true, gasEstimate };
    } catch (error: any) {
      const decodedError = this.decodeError(error);
      return { success: false, error: decodedError };
    }
  }

  private decodeError(error: any): string {
    const message = error.message || '';
    if (message.includes('insufficient funds')) return 'Insufficient funds for gas + price';
    if (message.includes('execution reverted')) {
      if (message.includes('sold out')) return 'Mint sold out';
      if (message.includes('paused')) return 'Minting is paused';
      if (message.includes('max supply')) return 'Exceeds max supply';
      if (message.includes('caller is not whitelisted')) return 'Not whitelisted';
      return `Contract reverted: ${message.split('reverted: ')[1] || 'Unknown reason'}`;
    }
    return message;
  }

  async executeMint(
    privateKey: string,
    params: MintParams,
    onStatusUpdate: (status: Partial<WalletStatus>) => void,
    retryCount = 2
  ): Promise<string> {
    let attempt = 0;
    while (attempt <= retryCount) {
      try {
        const wallet = new ethers.Wallet(privateKey, this.provider);
        const address = wallet.address;
        
        onStatusUpdate({ address, status: 'preparing' });
        
        const balance = await this.getBalance(address);
        onStatusUpdate({ balance });

        const totalCost = parseFloat(params.mintPrice) * params.quantity;
        if (parseFloat(balance) < totalCost) {
          throw new Error('Insufficient funds for mint price');
        }

        onStatusUpdate({ status: 'simulating' });
        const sim = await this.simulateMint(wallet, params);
        if (!sim.success) {
          throw new Error(sim.error);
        }

        onStatusUpdate({ status: 'executing' });
        
        const abi = params.manualAbi ? JSON.parse(params.manualAbi) : [
          `function ${params.functionName}(uint256 quantity) public payable`
        ];
        const contract = new ethers.Contract(params.contractAddress, abi, wallet);
        const value = ethers.parseEther(totalCost.toString());

        const feeData = await this.provider.getFeeData();
        let maxFeePerGas = feeData.maxFeePerGas;
        let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
        
        if (params.gasPreference === 'aggressive') {
          maxPriorityFeePerGas = (maxPriorityFeePerGas! * 200n) / 100n;
          maxFeePerGas = (maxFeePerGas! * 150n) / 100n;
        } else if (params.gasPreference === 'standard') {
          maxPriorityFeePerGas = (maxPriorityFeePerGas! * 120n) / 100n;
        }

        const tx = await contract[params.functionName](params.quantity, {
          value,
          maxFeePerGas,
          maxPriorityFeePerGas,
          gasLimit: (sim.gasEstimate! * 130n) / 100n,
        });

        onStatusUpdate({ txHash: tx.hash });
        
        const receipt = await tx.wait();
        onStatusUpdate({ status: 'confirmed', gasUsed: receipt?.gasUsed.toString() });
        
        return tx.hash;
      } catch (error: any) {
        const decodedError = this.decodeError(error);
        if (attempt < retryCount && !decodedError.includes('Insufficient funds')) {
          attempt++;
          console.warn(`Retrying mint (attempt ${attempt})...`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        onStatusUpdate({ status: 'failed', error: decodedError });
        throw new Error(decodedError);
      }
    }
    throw new Error('Max retries reached');
  }
}
