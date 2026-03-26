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
          "function mint() public payable",
          "function publicMint(uint256 quantity) public payable",
          "function publicMint() public payable",
          "function claim(address receiver, uint256 quantity) public payable",
          "function claim(uint256 quantity) public payable",
          "function purchase() public payable",
          "function purchaseWithAmount(uint256 amount) public payable",
          "function purchaseFor(address user, uint256 amount) public payable",
          "function purchase(uint256 quantity) public payable",
          "function totalSupply() public view returns (uint256)",
          "function maxSupply() public view returns (uint256)",
          "function paused() public view returns (bool)",
          "function saleActive() public view returns (bool)",
          "function price() public view returns (uint256)",
          "function cost() public view returns (uint256)",
          "function MINT_PRICE() public view returns (uint256)"
        ];
      }

      const contract = new ethers.Contract(address, abi, p);
      const info: ContractInfo = { address, abi, isVerified: !!manualAbi };

      try {
        // Try to detect common fields
        const [totalSupply, maxSupply, paused, price, cost, mintPrice] = await Promise.allSettled([
          contract.totalSupply(),
          contract.maxSupply(),
          contract.paused(),
          contract.price(),
          contract.cost(),
          contract.MINT_PRICE()
        ]);

        if (totalSupply.status === 'fulfilled') info.totalSupply = Number(totalSupply.value);
        if (maxSupply.status === 'fulfilled') info.maxSupply = Number(maxSupply.value);
        if (paused.status === 'fulfilled') info.isPaused = paused.value;
        
        // Price detection
        if (price.status === 'fulfilled') info.price = ethers.formatEther(price.value);
        else if (cost.status === 'fulfilled') info.price = ethers.formatEther(cost.value);
        else if (mintPrice.status === 'fulfilled') info.price = ethers.formatEther(mintPrice.value);

        // Detect mint function and its signature
        const mintFunctions = ['mint', 'publicMint', 'claim', 'purchase', 'purchaseWithAmount', 'purchaseFor'];
        for (const fn of mintFunctions) {
          try {
            // Try to find any function that matches the name
            const fragments = contract.interface.fragments.filter(f => f.type === 'function' && (f as ethers.FunctionFragment).name === fn);
            if (fragments.length > 0) {
              info.mintFunction = fn;
              break;
            }
          } catch (e) {
            // Function might exist with different signature or not at all
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
      const abi = params.manualAbi ? JSON.parse(params.manualAbi) : [
        `function ${params.functionName}(uint256 quantity) public payable`,
        `function ${params.functionName}() public payable`,
        `function ${params.functionName}(address receiver, uint256 quantity) public payable`,
        `function ${params.functionName}(uint256 amount) public payable`,
        `function ${params.functionName}(address user, uint256 amount) public payable`
      ];
      const contract = new ethers.Contract(params.contractAddress, abi, connectedWallet);
      
      // Handle ambiguity by picking the first matching fragment
      const fragments = contract.interface.fragments.filter(f => f.type === 'function' && (f as ethers.FunctionFragment).name === params.functionName) as ethers.FunctionFragment[];
      if (fragments.length === 0) throw new Error(`Function ${params.functionName} not found in ABI`);

      const value = ethers.parseEther((parseFloat(params.mintPrice) * params.quantity).toString());
      
      // Try each fragment until one works or we run out
      let lastError: any;
      for (const fragment of fragments) {
        try {
          const args = this.prepareArgs(fragment, params, wallet.address);
          // Use the full signature to avoid ambiguity
          const signature = fragment.format();
          await contract[signature].staticCall(...args, { value });
          const gasEstimate = await contract[signature].estimateGas(...args, { value });
          return { success: true, gasEstimate };
        } catch (e) {
          lastError = e;
          continue;
        }
      }
      
      throw lastError || new Error(`Failed to simulate any variant of ${params.functionName}`);
    } catch (error: any) {
      const decodedError = this.decodeError(error, params.manualAbi);
      return { success: false, error: decodedError };
    }
  }

  private prepareArgs(fragment: ethers.FunctionFragment, params: MintParams, walletAddress: string): any[] {
    const args: any[] = [];
    fragment.inputs.forEach(input => {
      const name = (input.name || '').toLowerCase();
      if (name === 'quantity' || name === '_quantity' || name === 'amount' || name === '_amount') {
        args.push(params.quantity);
      } else if (input.type === 'address' && (name === 'receiver' || name === 'to' || name === '_to' || name === 'user' || name === '_user')) {
        args.push(walletAddress);
      } else if (input.type === 'uint256') {
        // Default to quantity for unknown uint256 if it's the only one
        if (fragment.inputs.length === 1) args.push(params.quantity);
        else args.push(0); // Placeholder
      }
    });
    return args;
  }

  private decodeError(error: any, abi?: string): string {
    let message = error.message || '';
    
    // Try to decode custom errors if ABI is available
    if (abi && error.data) {
      try {
        const iface = new ethers.Interface(JSON.parse(abi));
        const decoded = iface.parseError(error.data);
        if (decoded) {
          return `Contract Error: ${decoded.name}(${decoded.args.join(', ')})`;
        }
      } catch (e) {
        // Failed to decode custom error
      }
    }

    if (message.includes('insufficient funds')) return 'Insufficient funds for gas + price';
    if (message.includes('ambiguous function description')) return 'Ambiguous function call: Multiple signatures found. Try providing manual ABI.';
    if (message.includes('execution reverted')) {
      if (message.includes('sold out')) return 'Mint sold out';
      if (message.includes('paused')) return 'Minting is paused';
      if (message.includes('max supply')) return 'Exceeds max supply';
      if (message.includes('caller is not whitelisted')) return 'Not whitelisted';
      if (message.includes('max per wallet')) return 'Max per wallet reached';
      
      const revertReason = message.split('reverted: ')[1];
      if (revertReason) return `Contract reverted: ${revertReason.split('\n')[0]}`;
      
      // If we have raw data but couldn't decode it
      if (error.data && error.data.startsWith('0x')) {
        return `Contract reverted with raw data: ${error.data.slice(0, 10)}... (Try providing manual ABI)`;
      }
      
      return 'Contract reverted: Unknown reason (Check if mint is live or if you are whitelisted)';
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
          `function ${params.functionName}(uint256 quantity) public payable`,
          `function ${params.functionName}() public payable`,
          `function ${params.functionName}(address receiver, uint256 quantity) public payable`,
          `function ${params.functionName}(uint256 amount) public payable`,
          `function ${params.functionName}(address user, uint256 amount) public payable`
        ];
        const contract = new ethers.Contract(params.contractAddress, abi, wallet);
        
        // Handle ambiguity by picking the first matching fragment
        const fragments = contract.interface.fragments.filter(f => f.type === 'function' && (f as ethers.FunctionFragment).name === params.functionName) as ethers.FunctionFragment[];
        if (fragments.length === 0) throw new Error(`Function ${params.functionName} not found`);
        
        // Find the fragment that worked during simulation
        let workingFragment: ethers.FunctionFragment | null = null;
        let workingArgs: any[] = [];
        const value = ethers.parseEther(totalCost.toString());

        for (const fragment of fragments) {
          try {
            const args = this.prepareArgs(fragment, params, address);
            const signature = fragment.format();
            await contract[signature].staticCall(...args, { value });
            workingFragment = fragment;
            workingArgs = args;
            break;
          } catch (e) {
            continue;
          }
        }

        if (!workingFragment) throw new Error(`Failed to find a valid signature for ${params.functionName}`);

        const feeData = await this.provider.getFeeData();
        let maxFeePerGas = feeData.maxFeePerGas;
        let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
        
        if (params.gasPreference === 'aggressive') {
          maxPriorityFeePerGas = (maxPriorityFeePerGas! * 250n) / 100n;
          maxFeePerGas = (maxFeePerGas! * 200n) / 100n;
        } else if (params.gasPreference === 'standard') {
          maxPriorityFeePerGas = (maxPriorityFeePerGas! * 150n) / 100n;
          maxFeePerGas = (maxFeePerGas! * 120n) / 100n;
        }

        const signature = workingFragment.format();
        const tx = await contract[signature](...workingArgs, {
          value,
          maxFeePerGas,
          maxPriorityFeePerGas,
          gasLimit: (sim.gasEstimate! * 150n) / 100n, // Increased buffer
        });

        onStatusUpdate({ txHash: tx.hash });
        
        const receipt = await tx.wait();
        onStatusUpdate({ status: 'confirmed', gasUsed: receipt?.gasUsed.toString() });
        
        return tx.hash;
      } catch (error: any) {
        const decodedError = this.decodeError(error, params.manualAbi);
        if (attempt < retryCount && !decodedError.includes('Insufficient funds') && !decodedError.includes('Max per wallet')) {
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
