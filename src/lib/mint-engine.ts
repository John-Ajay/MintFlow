import { ethers } from 'ethers';
import { MintParams, Network, WalletStatus, ContractInfo } from '../types.ts';

const RPC_URLS: Record<Network, string[]> = {
  ethereum: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth', 'https://cloudflare-eth.com'],
  polygon: ['https://polygon.llamarpc.com', 'https://rpc-mainnet.matic.quiknode.pro', 'https://polygon-rpc.com'],
  base: ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://developer-access-mainnet.base.org'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com', 'https://rpc.ankr.com/arbitrum'],
  optimism: ['https://mainnet.optimism.io', 'https://optimism.llamarpc.com', 'https://rpc.ankr.com/optimism'],
};

// Extended ABI covering ERC721A, Manifold, ThirdWeb, Zora, custom drops, and phased minting
const COMMON_MINT_ABI = [
  // ── Mint / Claim functions ──────────────────────────────────────────────
  "function mint(uint256 quantity) public payable",
  "function mint() public payable",
  "function mint(address to, uint256 quantity) public payable",
  "function publicMint(uint256 quantity) public payable",
  "function publicMint() public payable",
  "function claim(address receiver, uint256 quantity, address currency, uint256 pricePerToken, bytes32[] proof, uint256 quantityLimitPerWallet) public payable",
  "function claim(uint256 quantity) public payable",
  "function purchase() public payable",
  "function purchase(uint256 quantity) public payable",
  "function purchaseWithAmount(uint256 amount) public payable",
  "function purchaseFor(address user, uint256 amount) public payable",
  "function mintPublic(address to, uint256 tokenId, uint256 quantity, bytes data) public payable",
  "function mintWithRewards(address to, uint256 quantity, string comment, address mintReferral) public payable",
  "function buy(uint256 quantity) public payable",
  "function freeMint(uint256 quantity) public",
  "function mintFree() public",

  // ── Supply ──────────────────────────────────────────────────────────────
  "function totalSupply() public view returns (uint256)",
  "function maxSupply() public view returns (uint256)",
  "function MAX_SUPPLY() public view returns (uint256)",
  "function totalMinted() public view returns (uint256)",
  "function _totalMinted() public view returns (uint256)",
  "function collectionSize() public view returns (uint256)",
  "function maxTokens() public view returns (uint256)",

  // ── Pause / Sale state ──────────────────────────────────────────────────
  "function paused() public view returns (bool)",
  "function isPaused() public view returns (bool)",
  "function saleActive() public view returns (bool)",
  "function isSaleActive() public view returns (bool)",
  "function publicSaleActive() public view returns (bool)",
  "function isPublicSaleActive() public view returns (bool)",
  "function mintingEnabled() public view returns (bool)",
  "function mintEnabled() public view returns (bool)",

  // ── Price ───────────────────────────────────────────────────────────────
  "function price() public view returns (uint256)",
  "function cost() public view returns (uint256)",
  "function mintPrice() public view returns (uint256)",
  "function publicPrice() public view returns (uint256)",
  "function unitPrice() public view returns (uint256)",
  "function MINT_PRICE() public view returns (uint256)",
  "function PUBLIC_SALE_PRICE() public view returns (uint256)",
  "function getPrice() public view returns (uint256)",
  "function salePrice() public view returns (uint256)",
  "function pricePerToken() public view returns (uint256)",
  "function priceInWei() public view returns (uint256)",

  // ── Quantity limits ─────────────────────────────────────────────────────
  "function maxPerWallet() public view returns (uint256)",
  "function maxMintPerWallet() public view returns (uint256)",
  "function walletLimit() public view returns (uint256)",
  "function maxPerTransaction() public view returns (uint256)",
  "function maxMintPerTx() public view returns (uint256)",
  "function maxPerTx() public view returns (uint256)",
  "function minMintQuantity() public view returns (uint256)",
  "function maxMintQuantity() public view returns (uint256)",
  "function MAX_PER_WALLET() public view returns (uint256)",
  "function MAX_PER_TX() public view returns (uint256)",
  "function mintLimit() public view returns (uint256)",

  // ── ThirdWeb ClaimCondition phase (getActiveClaimCondition) ────────────
  "function getActiveClaimConditionId() public view returns (uint256)",
  "function getClaimConditionById(uint256 conditionId) public view returns (tuple(uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata))",

  // ── Zora / Edition style ────────────────────────────────────────────────
  "function saleDetails() public view returns (tuple(bool publicSaleActive, bool presaleActive, uint256 publicSalePrice, uint64 publicSaleStart, uint64 publicSaleEnd, uint64 presaleStart, uint64 presaleEnd, bytes32 presaleMerkleRoot, uint256 maxSalePurchasePerAddress, uint256 totalMinted, uint256 maxSupply))",
  "function zoraFeeForAmount(uint256 quantity) public view returns (address recipient, uint256 fee)",
];

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

  // ─── URL / address extraction ────────────────────────────────────────────────
  // Supports:
  //   • Raw 0x address
  //   • OpenSea: https://opensea.io/assets/ethereum/0x.../1
  //   • OpenSea drop: https://opensea.io/collection/*/drop
  //   • Any project mint site that embeds a 0x address in the URL path/query
  static extractContractAddress(input: string): string {
    const hex40 = /0x[a-fA-F0-9]{40}/;
    const match = input.match(hex40);
    if (match) return match[0];
    return input.trim();
  }

  // ─── Fetch live gas in Gwei ──────────────────────────────────────────────────
  async getGasInfo(): Promise<{ baseFeeGwei: string; priorityFeeGwei: string; totalGwei: string }> {
    return this.callWithRetry(async (p) => {
      const feeData = await p.getFeeData();
      const baseFee = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
      const priority = feeData.maxPriorityFeePerGas ?? 0n;
      const baseFeeGwei = parseFloat(ethers.formatUnits(baseFee, 'gwei')).toFixed(2);
      const priorityFeeGwei = parseFloat(ethers.formatUnits(priority, 'gwei')).toFixed(2);
      const totalGwei = parseFloat(ethers.formatUnits(baseFee + priority, 'gwei')).toFixed(2);
      return { baseFeeGwei, priorityFeeGwei, totalGwei };
    });
  }

  // ─── Main contract analysis ──────────────────────────────────────────────────
  async analyzeContract(address: string, manualAbi?: string): Promise<ContractInfo> {
    return this.callWithRetry(async (p) => {
      let abi: any[] = [];
      if (manualAbi) {
        try {
          abi = JSON.parse(manualAbi);
        } catch {
          throw new Error('Invalid manual ABI format');
        }
      } else {
        abi = COMMON_MINT_ABI;
      }

      const contract = new ethers.Contract(address, abi, p);
      const info: ContractInfo = {
        address,
        abi,
        isVerified: !!manualAbi,
      };

      // ── Parallel multicall for all view functions ──────────────────────────
      const [
        totalSupply, maxSupply, MAX_SUPPLY, totalMinted, _totalMinted, collectionSize, maxTokens,
        paused, isPaused, saleActive, isSaleActive, publicSaleActive, isPublicSaleActive, mintingEnabled, mintEnabled,
        price, cost, mintPrice, publicPrice, unitPrice, MINT_PRICE, PUBLIC_SALE_PRICE, getPrice, salePrice, pricePerToken, priceInWei,
        maxPerWallet, maxMintPerWallet, walletLimit, maxPerTransaction, maxMintPerTx, maxPerTx, minMintQty, maxMintQty, MAX_PER_WALLET, MAX_PER_TX, mintLimit,
        activeClaimConditionId,
        saleDetails,
      ] = await Promise.allSettled([
        contract.totalSupply(),
        contract.maxSupply(),
        contract.MAX_SUPPLY(),
        contract.totalMinted(),
        contract._totalMinted(),
        contract.collectionSize(),
        contract.maxTokens(),

        contract.paused(),
        contract.isPaused(),
        contract.saleActive(),
        contract.isSaleActive(),
        contract.publicSaleActive(),
        contract.isPublicSaleActive(),
        contract.mintingEnabled(),
        contract.mintEnabled(),

        contract.price(),
        contract.cost(),
        contract.mintPrice(),
        contract.publicPrice(),
        contract.unitPrice(),
        contract.MINT_PRICE(),
        contract.PUBLIC_SALE_PRICE(),
        contract.getPrice(),
        contract.salePrice(),
        contract.pricePerToken(),
        contract.priceInWei(),

        contract.maxPerWallet(),
        contract.maxMintPerWallet(),
        contract.walletLimit(),
        contract.maxPerTransaction(),
        contract.maxMintPerTx(),
        contract.maxPerTx(),
        contract.minMintQuantity(),
        contract.maxMintQuantity(),
        contract.MAX_PER_WALLET(),
        contract.MAX_PER_TX(),
        contract.mintLimit(),

        contract.getActiveClaimConditionId(),
        contract.saleDetails(),
      ]);

      // ── Supply ─────────────────────────────────────────────────────────────
      const supplyVal = [totalSupply, totalMinted, _totalMinted].find(r => r.status === 'fulfilled');
      if (supplyVal?.status === 'fulfilled') info.totalSupply = Number(supplyVal.value);

      const maxSupplyVal = [maxSupply, MAX_SUPPLY, collectionSize, maxTokens].find(r => r.status === 'fulfilled');
      if (maxSupplyVal?.status === 'fulfilled') info.maxSupply = Number(maxSupplyVal.value);

      // ── Pause / phase ──────────────────────────────────────────────────────
      if (paused.status === 'fulfilled') info.isPaused = Boolean(paused.value);
      else if (isPaused.status === 'fulfilled') info.isPaused = Boolean(isPaused.value);
      else if (publicSaleActive.status === 'fulfilled') info.isPaused = !publicSaleActive.value;
      else if (isPublicSaleActive.status === 'fulfilled') info.isPaused = !isPublicSaleActive.value;
      else if (saleActive.status === 'fulfilled') info.isPaused = !saleActive.value;
      else if (isSaleActive.status === 'fulfilled') info.isPaused = !isSaleActive.value;
      else if (mintingEnabled.status === 'fulfilled') info.isPaused = !mintingEnabled.value;
      else if (mintEnabled.status === 'fulfilled') info.isPaused = !mintEnabled.value;

      // ── Price — check all variants; pick first non-zero ────────────────────
      const priceResults = [price, cost, mintPrice, publicPrice, unitPrice, MINT_PRICE, PUBLIC_SALE_PRICE, getPrice, salePrice, pricePerToken, priceInWei];
      for (const pVal of priceResults) {
        if (pVal.status === 'fulfilled' && pVal.value !== undefined) {
          const formatted = ethers.formatEther(pVal.value);
          if (parseFloat(formatted) >= 0) {
            info.price = formatted;
            info.priceWei = pVal.value.toString();
            break;
          }
        }
      }

      // ── Quantity limits ────────────────────────────────────────────────────
      const minQty = minMintQty;
      if (minQty.status === 'fulfilled') info.minQuantity = Number(minQty.value);
      else info.minQuantity = 1; // safe default

      const maxQtyResults = [maxPerTransaction, maxMintPerTx, maxPerTx, MAX_PER_TX, maxMintQty, maxPerWallet, maxMintPerWallet, walletLimit, MAX_PER_WALLET, mintLimit];
      for (const r of maxQtyResults) {
        if (r.status === 'fulfilled' && Number(r.value) > 0) {
          info.maxQuantity = Number(r.value);
          break;
        }
      }

      // ── ThirdWeb phased minting — getActiveClaimCondition ──────────────────
      if (activeClaimConditionId.status === 'fulfilled') {
        try {
          const conditionId = activeClaimConditionId.value;
          const condition = await contract.getClaimConditionById(conditionId);
          info.currentPhase = `Phase ${conditionId.toString()}`;
          if (condition.pricePerToken !== undefined) {
            info.price = ethers.formatEther(condition.pricePerToken);
            info.priceWei = condition.pricePerToken.toString();
          }
          if (condition.quantityLimitPerWallet !== undefined) {
            info.maxQuantity = Number(condition.quantityLimitPerWallet);
          }
          if (condition.maxClaimableSupply !== undefined) {
            info.maxSupply = Number(condition.maxClaimableSupply);
          }
          if (condition.supplyClaimed !== undefined) {
            info.totalSupply = Number(condition.supplyClaimed);
          }
          // Phase is paused if startTimestamp is in the future
          if (condition.startTimestamp !== undefined) {
            const now = Math.floor(Date.now() / 1000);
            if (Number(condition.startTimestamp) > now) {
              info.isPaused = true;
            }
          }
        } catch {
          // ThirdWeb condition fetch failed — continue with what we have
        }
      }

      // ── Zora / Edition saleDetails ─────────────────────────────────────────
      if (saleDetails.status === 'fulfilled') {
        const sd = saleDetails.value;
        if (sd.publicSaleActive !== undefined) info.isPaused = !sd.publicSaleActive;
        if (sd.publicSalePrice !== undefined && BigInt(sd.publicSalePrice) > 0n) {
          info.price = ethers.formatEther(sd.publicSalePrice);
          info.priceWei = sd.publicSalePrice.toString();
        }
        if (sd.maxSupply !== undefined) info.maxSupply = Number(sd.maxSupply);
        if (sd.totalMinted !== undefined) info.totalSupply = Number(sd.totalMinted);
        if (sd.maxSalePurchasePerAddress !== undefined) info.maxQuantity = Number(sd.maxSalePurchasePerAddress);
        info.currentPhase = sd.presaleActive ? 'Presale' : sd.publicSaleActive ? 'Public Sale' : 'Not Active';
      }

      // ── Live gas info ──────────────────────────────────────────────────────
      try {
        info.gasInfo = await this.getGasInfo();
      } catch {
        // non-fatal
      }

      // ── Detect mint function ───────────────────────────────────────────────
      const mintFunctions = ['mint', 'publicMint', 'claim', 'purchase', 'purchaseWithAmount', 'purchaseFor', 'mintPublic', 'mintWithRewards', 'buy', 'freeMint', 'mintFree'];
      for (const fn of mintFunctions) {
        const fragments = contract.interface.fragments.filter(
          f => f.type === 'function' && (f as ethers.FunctionFragment).name === fn
        );
        if (fragments.length > 0) {
          info.mintFunction = fn;
          break;
        }
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
      const abi = params.manualAbi ? JSON.parse(params.manualAbi) : COMMON_MINT_ABI;
      const contract = new ethers.Contract(params.contractAddress, abi, connectedWallet);

      const fragments = contract.interface.fragments.filter(
        f => f.type === 'function' && (f as ethers.FunctionFragment).name === params.functionName
      ) as ethers.FunctionFragment[];
      if (fragments.length === 0) throw new Error(`Function ${params.functionName} not found in ABI`);

      const value = ethers.parseEther((parseFloat(params.mintPrice) * params.quantity).toFixed(18));

      let lastError: any;
      for (const fragment of fragments) {
        try {
          const args = this.prepareArgs(fragment, params, wallet.address);
          const signature = fragment.format();
          await contract[signature].staticCall(...args, { value });
          const gasEstimate = await contract[signature].estimateGas(...args, { value });
          return { success: true, gasEstimate };
        } catch (e) {
          lastError = e;
        }
      }

      throw lastError || new Error(`Failed to simulate ${params.functionName}`);
    } catch (error: any) {
      return { success: false, error: this.decodeError(error, params.manualAbi) };
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
        if (fragment.inputs.length === 1) args.push(params.quantity);
        else args.push(0);
      } else if (input.type === 'bytes32[]') {
        args.push([]); // empty merkle proof — public mint
      } else if (input.type === 'bytes') {
        args.push('0x');
      } else if (input.type === 'string') {
        args.push('');
      } else if (input.type === 'address') {
        args.push(ethers.ZeroAddress);
      }
    });
    return args;
  }

  private decodeError(error: any, abi?: string): string {
    let message = error.message || '';

    if (abi && error.data) {
      try {
        const iface = new ethers.Interface(JSON.parse(abi));
        const decoded = iface.parseError(error.data);
        if (decoded) return `Contract Error: ${decoded.name}(${decoded.args.join(', ')})`;
      } catch { /* ignore */ }
    }

    if (message.includes('insufficient funds')) return 'Insufficient funds for gas + price';
    if (message.includes('ambiguous function')) return 'Ambiguous function: provide manual ABI';
    if (message.includes('execution reverted')) {
      if (message.includes('sold out') || message.includes('Sold out')) return 'Mint sold out';
      if (message.includes('paused') || message.includes('Paused')) return 'Minting is paused';
      if (message.includes('max supply') || message.includes('MaxSupply')) return 'Exceeds max supply';
      if (message.includes('not whitelisted') || message.includes('MerkleProof')) return 'Not whitelisted / not eligible';
      if (message.includes('max per wallet') || message.includes('ExceedsWalletLimit')) return 'Max per wallet reached';
      if (message.includes('not started') || message.includes('not live')) return 'Sale has not started yet';
      const revertReason = message.split('reverted: ')[1];
      if (revertReason) return `Reverted: ${revertReason.split('\n')[0]}`;
      if (error.data?.startsWith('0x')) return `Reverted with raw data: ${error.data.slice(0, 10)}... (provide manual ABI)`;
      return 'Reverted: Unknown reason — check if mint is live or if you are whitelisted';
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
        if (!sim.success) throw new Error(sim.error);

        onStatusUpdate({ status: 'executing' });

        const abi = params.manualAbi ? JSON.parse(params.manualAbi) : COMMON_MINT_ABI;
        const contract = new ethers.Contract(params.contractAddress, abi, wallet);

        const fragments = contract.interface.fragments.filter(
          f => f.type === 'function' && (f as ethers.FunctionFragment).name === params.functionName
        ) as ethers.FunctionFragment[];
        if (fragments.length === 0) throw new Error(`Function ${params.functionName} not found`);

        const value = ethers.parseEther(totalCost.toFixed(18));

        // Find working fragment (same logic as simulation — guaranteed to match)
        let workingFragment: ethers.FunctionFragment | null = null;
        let workingArgs: any[] = [];

        for (const fragment of fragments) {
          try {
            const args = this.prepareArgs(fragment, params, address);
            const signature = fragment.format();
            await contract[signature].staticCall(...args, { value });
            workingFragment = fragment;
            workingArgs = args;
            break;
          } catch { continue; }
        }

        if (!workingFragment) throw new Error(`No valid signature found for ${params.functionName}`);

        // ── Gas — fetch once and apply strategy ─────────────────────────────
        const feeData = await this.provider.getFeeData();
        let maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
        let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 0n;

        if (params.gasPreference === 'aggressive') {
          maxPriorityFeePerGas = (maxPriorityFeePerGas * 300n) / 100n; // 3× priority for speed
          maxFeePerGas = (maxFeePerGas * 220n) / 100n;
        } else if (params.gasPreference === 'standard') {
          maxPriorityFeePerGas = (maxPriorityFeePerGas * 150n) / 100n;
          maxFeePerGas = (maxFeePerGas * 130n) / 100n;
        }
        // 'low' keeps feeData as-is

        const signature = workingFragment.format();

        // ── Submit transaction (no await on .wait() here — fire fast) ────────
        const tx = await contract[signature](...workingArgs, {
          value,
          maxFeePerGas,
          maxPriorityFeePerGas,
          gasLimit: (sim.gasEstimate! * 130n) / 100n, // tighter buffer = faster inclusion
        });

        onStatusUpdate({ txHash: tx.hash });

        // Wait for 1 confirmation only — fast confirmation
        const receipt = await tx.wait(1);
        onStatusUpdate({ status: 'confirmed', gasUsed: receipt?.gasUsed.toString() });

        return tx.hash;
      } catch (error: any) {
        const decodedError = this.decodeError(error, params.manualAbi);
        if (
          attempt < retryCount &&
          !decodedError.includes('Insufficient funds') &&
          !decodedError.includes('Max per wallet')
        ) {
          attempt++;
          await new Promise(r => setTimeout(r, 800 * attempt));
          continue;
        }
        onStatusUpdate({ status: 'failed', error: decodedError });
        throw new Error(decodedError);
      }
    }
    throw new Error('Max retries reached');
  }
}
