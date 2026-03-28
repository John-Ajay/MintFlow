import { ethers } from 'ethers';
import { MintParams, Network, WalletStatus, ContractInfo } from '../types.ts';

const RPC_URLS: Record<Network, string[]> = {
  ethereum: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth', 'https://cloudflare-eth.com'],
  polygon: ['https://polygon.llamarpc.com', 'https://rpc-mainnet.matic.quiknode.pro', 'https://polygon-rpc.com'],
  base: ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://developer-access-mainnet.base.org'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com', 'https://rpc.ankr.com/arbitrum'],
  optimism: ['https://mainnet.optimism.io', 'https://optimism.llamarpc.com', 'https://rpc.ankr.com/optimism'],
};

// ─── SeaDrop contract addresses per network ───────────────────────────────────
const SEADROP_ADDRESSES: Partial<Record<Network, string>> = {
  ethereum: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  base:     '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  optimism: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
};

// SeaDrop contract ABI — only what we need
const SEADROP_ABI = [
  "function getPublicDrop(address nftContract) external view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients) publicDrop)",
  "function getFeeRecipients(address nftContract) external view returns (address[])",
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) external payable",
];

// NFT contract side — SeaDrop-specific read functions
const SEADROP_NFT_ABI = [
  "function getMintStats(address minter) external view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
  "function maxSupply() public view returns (uint256)",
  "function totalSupply() public view returns (uint256)",
  "function paused() public view returns (bool)",
];

// Extended ABI covering ERC721A, Manifold, ThirdWeb, Zora, custom drops, and phased minting
const COMMON_MINT_ABI = [
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
  "function totalSupply() public view returns (uint256)",
  "function maxSupply() public view returns (uint256)",
  "function MAX_SUPPLY() public view returns (uint256)",
  "function totalMinted() public view returns (uint256)",
  "function _totalMinted() public view returns (uint256)",
  "function collectionSize() public view returns (uint256)",
  "function maxTokens() public view returns (uint256)",
  "function paused() public view returns (bool)",
  "function isPaused() public view returns (bool)",
  "function saleActive() public view returns (bool)",
  "function isSaleActive() public view returns (bool)",
  "function publicSaleActive() public view returns (bool)",
  "function isPublicSaleActive() public view returns (bool)",
  "function mintingEnabled() public view returns (bool)",
  "function mintEnabled() public view returns (bool)",
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
  "function getMintStats(address minter) external view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
  "function getActiveClaimConditionId() public view returns (uint256)",
  "function getClaimConditionById(uint256 conditionId) public view returns (tuple(uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata))",
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

  static extractContractAddress(input: string): string {
    const hex40 = /0x[a-fA-F0-9]{40}/;
    const match = input.match(hex40);
    if (match) return match[0];
    return input.trim();
  }

  async getGasInfo(): Promise<{ baseFeeGwei: string; priorityFeeGwei: string; totalGwei: string }> {
    return this.callWithRetry(async (p) => {
      const feeData = await p.getFeeData();
      const baseFee = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
      const priority = feeData.maxPriorityFeePerGas ?? 0n;
      return {
        baseFeeGwei:     parseFloat(ethers.formatUnits(baseFee, 'gwei')).toFixed(2),
        priorityFeeGwei: parseFloat(ethers.formatUnits(priority, 'gwei')).toFixed(2),
        totalGwei:       parseFloat(ethers.formatUnits(baseFee + priority, 'gwei')).toFixed(2),
      };
    });
  }

  // ─── SeaDrop: probe + fetch drop config ───────────────────────────────────
  private async detectSeaDrop(nftAddress: string, p: ethers.JsonRpcProvider): Promise<{
    isSeaDrop: boolean;
    seaDropAddress?: string;
    mintPrice?: string;
    priceWei?: string;
    feeRecipient?: string;
    maxPerWallet?: number;
    isPaused?: boolean;
  }> {
    const seaDropAddress = SEADROP_ADDRESSES[this.network];
    if (!seaDropAddress) return { isSeaDrop: false };

    try {
      // Probe: getMintStats exists only on SeaDrop NFT contracts
      const nftContract = new ethers.Contract(nftAddress, SEADROP_NFT_ABI, p);
      await nftContract.getMintStats(ethers.ZeroAddress);

      // Confirmed SeaDrop — pull drop config from the SeaDrop contract
      const seaDrop = new ethers.Contract(seaDropAddress, SEADROP_ABI, p);
      const [publicDropResult, feeRecipientsResult] = await Promise.allSettled([
        seaDrop.getPublicDrop(nftAddress),
        seaDrop.getFeeRecipients(nftAddress),
      ]);

      let mintPrice: string | undefined;
      let priceWei: string | undefined;
      let feeRecipient: string | undefined;
      let maxPerWallet: number | undefined;
      let isPaused = false;

      if (publicDropResult.status === 'fulfilled') {
        const drop = publicDropResult.value;
        priceWei  = drop.mintPrice.toString();
        mintPrice = ethers.formatEther(drop.mintPrice);
        maxPerWallet = Number(drop.maxTotalMintableByWallet);
        const now = Math.floor(Date.now() / 1000);
        isPaused = Number(drop.startTime) > now || (Number(drop.endTime) > 0 && Number(drop.endTime) < now);
      }

      if (feeRecipientsResult.status === 'fulfilled' && feeRecipientsResult.value.length > 0) {
        feeRecipient = feeRecipientsResult.value[0];
      } else {
        // Fallback to OpenSea's known fee recipient
        feeRecipient = '0x0000a26b00c1F0DF003000390027140000fAa719';
      }

      return { isSeaDrop: true, seaDropAddress, mintPrice, priceWei, feeRecipient, maxPerWallet, isPaused };
    } catch {
      return { isSeaDrop: false };
    }
  }

  // ─── Main contract analysis ───────────────────────────────────────────────
  async analyzeContract(address: string, manualAbi?: string): Promise<ContractInfo> {
    return this.callWithRetry(async (p) => {
      let abi: any[] = [];
      if (manualAbi) {
        try { abi = JSON.parse(manualAbi); }
        catch { throw new Error('Invalid manual ABI format'); }
      } else {
        abi = COMMON_MINT_ABI;
      }

      const info: ContractInfo = { address, abi, isVerified: !!manualAbi };

      // ── SeaDrop detection first ────────────────────────────────────────────
      const seaDropInfo = await this.detectSeaDrop(address, p);
      if (seaDropInfo.isSeaDrop) {
        info.isSeaDrop          = true;
        info.seaDropAddress     = seaDropInfo.seaDropAddress;
        info.seaDropFeeRecipient = seaDropInfo.feeRecipient;
        info.currentPhase       = 'Public Drop (SeaDrop)';
        info.mintFunction       = 'mintPublic';
        info.minQuantity        = 1;

        if (seaDropInfo.mintPrice !== undefined) {
          info.price    = seaDropInfo.mintPrice;
          info.priceWei = seaDropInfo.priceWei;
        }
        if (seaDropInfo.maxPerWallet !== undefined && seaDropInfo.maxPerWallet > 0) {
          info.maxQuantity = seaDropInfo.maxPerWallet;
        }
        if (seaDropInfo.isPaused !== undefined) info.isPaused = seaDropInfo.isPaused;

        // Supply from getMintStats
        try {
          const nftContract = new ethers.Contract(address, SEADROP_NFT_ABI, p);
          const stats = await nftContract.getMintStats(ethers.ZeroAddress);
          info.totalSupply = Number(stats.currentTotalSupply);
          info.maxSupply   = Number(stats.maxSupply);
        } catch { /* non-fatal */ }

        try { info.gasInfo = await this.getGasInfo(); } catch { /* non-fatal */ }
        return info;
      }

      // ── Standard contract analysis ─────────────────────────────────────────
      const contract = new ethers.Contract(address, abi, p);

      const [
        totalSupply, maxSupply, MAX_SUPPLY, totalMinted, _totalMinted, collectionSize, maxTokens,
        paused, isPaused, saleActive, isSaleActive, publicSaleActive, isPublicSaleActive, mintingEnabled, mintEnabled,
        price, cost, mintPrice, publicPrice, unitPrice, MINT_PRICE, PUBLIC_SALE_PRICE, getPrice, salePrice, pricePerToken, priceInWei,
        maxPerWallet, maxMintPerWallet, walletLimit, maxPerTransaction, maxMintPerTx, maxPerTx, minMintQty, maxMintQty, MAX_PER_WALLET, MAX_PER_TX, mintLimit,
        activeClaimConditionId,
        saleDetails,
      ] = await Promise.allSettled([
        contract.totalSupply(), contract.maxSupply(), contract.MAX_SUPPLY(),
        contract.totalMinted(), contract._totalMinted(), contract.collectionSize(), contract.maxTokens(),
        contract.paused(), contract.isPaused(), contract.saleActive(), contract.isSaleActive(),
        contract.publicSaleActive(), contract.isPublicSaleActive(), contract.mintingEnabled(), contract.mintEnabled(),
        contract.price(), contract.cost(), contract.mintPrice(), contract.publicPrice(),
        contract.unitPrice(), contract.MINT_PRICE(), contract.PUBLIC_SALE_PRICE(), contract.getPrice(),
        contract.salePrice(), contract.pricePerToken(), contract.priceInWei(),
        contract.maxPerWallet(), contract.maxMintPerWallet(), contract.walletLimit(),
        contract.maxPerTransaction(), contract.maxMintPerTx(), contract.maxPerTx(),
        contract.minMintQuantity(), contract.maxMintQuantity(), contract.MAX_PER_WALLET(),
        contract.MAX_PER_TX(), contract.mintLimit(),
        contract.getActiveClaimConditionId(),
        contract.saleDetails(),
      ]);

      // Supply
      const supplyVal = [totalSupply, totalMinted, _totalMinted].find(r => r.status === 'fulfilled');
      if (supplyVal?.status === 'fulfilled') info.totalSupply = Number(supplyVal.value);
      const maxSupplyVal = [maxSupply, MAX_SUPPLY, collectionSize, maxTokens].find(r => r.status === 'fulfilled');
      if (maxSupplyVal?.status === 'fulfilled') info.maxSupply = Number(maxSupplyVal.value);

      // Pause
      if (paused.status === 'fulfilled') info.isPaused = Boolean(paused.value);
      else if (isPaused.status === 'fulfilled') info.isPaused = Boolean(isPaused.value);
      else if (publicSaleActive.status === 'fulfilled') info.isPaused = !publicSaleActive.value;
      else if (isPublicSaleActive.status === 'fulfilled') info.isPaused = !isPublicSaleActive.value;
      else if (saleActive.status === 'fulfilled') info.isPaused = !saleActive.value;
      else if (isSaleActive.status === 'fulfilled') info.isPaused = !isSaleActive.value;
      else if (mintingEnabled.status === 'fulfilled') info.isPaused = !mintingEnabled.value;
      else if (mintEnabled.status === 'fulfilled') info.isPaused = !mintEnabled.value;

      // Price
      for (const pVal of [price, cost, mintPrice, publicPrice, unitPrice, MINT_PRICE, PUBLIC_SALE_PRICE, getPrice, salePrice, pricePerToken, priceInWei]) {
        if (pVal.status === 'fulfilled' && pVal.value !== undefined) {
          const formatted = ethers.formatEther(pVal.value);
          if (parseFloat(formatted) >= 0) {
            info.price    = formatted;
            info.priceWei = pVal.value.toString();
            break;
          }
        }
      }

      // Quantity limits
      info.minQuantity = minMintQty.status === 'fulfilled' ? Number(minMintQty.value) : 1;
      for (const r of [maxPerTransaction, maxMintPerTx, maxPerTx, MAX_PER_TX, maxMintQty, maxPerWallet, maxMintPerWallet, walletLimit, MAX_PER_WALLET, mintLimit]) {
        if (r.status === 'fulfilled' && Number(r.value) > 0) {
          info.maxQuantity = Number(r.value);
          break;
        }
      }

      // ThirdWeb phased
      if (activeClaimConditionId.status === 'fulfilled') {
        try {
          const conditionId = activeClaimConditionId.value;
          const condition = await contract.getClaimConditionById(conditionId);
          info.currentPhase = `Phase ${conditionId.toString()}`;
          if (condition.pricePerToken !== undefined) {
            info.price    = ethers.formatEther(condition.pricePerToken);
            info.priceWei = condition.pricePerToken.toString();
          }
          if (condition.quantityLimitPerWallet !== undefined) info.maxQuantity = Number(condition.quantityLimitPerWallet);
          if (condition.maxClaimableSupply !== undefined)     info.maxSupply   = Number(condition.maxClaimableSupply);
          if (condition.supplyClaimed !== undefined)          info.totalSupply = Number(condition.supplyClaimed);
          if (condition.startTimestamp !== undefined) {
            if (Number(condition.startTimestamp) > Math.floor(Date.now() / 1000)) info.isPaused = true;
          }
        } catch { /* non-fatal */ }
      }

      // Zora
      if (saleDetails.status === 'fulfilled') {
        const sd = saleDetails.value;
        if (sd.publicSaleActive !== undefined) info.isPaused = !sd.publicSaleActive;
        if (sd.publicSalePrice !== undefined && BigInt(sd.publicSalePrice) > 0n) {
          info.price    = ethers.formatEther(sd.publicSalePrice);
          info.priceWei = sd.publicSalePrice.toString();
        }
        if (sd.maxSupply !== undefined)                  info.maxSupply   = Number(sd.maxSupply);
        if (sd.totalMinted !== undefined)                info.totalSupply = Number(sd.totalMinted);
        if (sd.maxSalePurchasePerAddress !== undefined)  info.maxQuantity = Number(sd.maxSalePurchasePerAddress);
        info.currentPhase = sd.presaleActive ? 'Presale' : sd.publicSaleActive ? 'Public Sale' : 'Not Active';
      }

      try { info.gasInfo = await this.getGasInfo(); } catch { /* non-fatal */ }

      // Mint function detection
      for (const fn of ['mint', 'publicMint', 'claim', 'purchase', 'purchaseWithAmount', 'purchaseFor', 'mintPublic', 'mintWithRewards', 'buy', 'freeMint', 'mintFree']) {
        const fragments = contract.interface.fragments.filter(
          f => f.type === 'function' && (f as ethers.FunctionFragment).name === fn
        );
        if (fragments.length > 0) { info.mintFunction = fn; break; }
      }

      return info;
    });
  }

  // ─── SeaDrop mint execution ───────────────────────────────────────────────
  private async executeSeaDropMint(
    wallet: ethers.Wallet,
    params: MintParams,
    seaDropAddress: string,
    feeRecipient: string,
    onStatusUpdate: (status: Partial<WalletStatus>) => void
  ): Promise<string> {
    const seaDrop = new ethers.Contract(seaDropAddress, SEADROP_ABI, wallet);
    const value   = ethers.parseEther((parseFloat(params.mintPrice) * params.quantity).toFixed(18));

    // Static call simulation
    try {
      await seaDrop.mintPublic.staticCall(
        params.contractAddress, feeRecipient, wallet.address, params.quantity, { value }
      );
    } catch (err: any) {
      throw new Error(this.decodeError(err));
    }

    const gasEstimate = await seaDrop.mintPublic.estimateGas(
      params.contractAddress, feeRecipient, wallet.address, params.quantity, { value }
    );

    const feeData = await this.provider.getFeeData();
    let maxFeePerGas         = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 0n;

    if (params.gasPreference === 'aggressive') {
      maxPriorityFeePerGas = (maxPriorityFeePerGas * 300n) / 100n;
      maxFeePerGas         = (maxFeePerGas * 220n) / 100n;
    } else if (params.gasPreference === 'standard') {
      maxPriorityFeePerGas = (maxPriorityFeePerGas * 150n) / 100n;
      maxFeePerGas         = (maxFeePerGas * 130n) / 100n;
    }

    onStatusUpdate({ status: 'executing' });

    const tx = await seaDrop.mintPublic(
      params.contractAddress, feeRecipient, wallet.address, params.quantity,
      { value, maxFeePerGas, maxPriorityFeePerGas, gasLimit: (gasEstimate * 130n) / 100n }
    );

    onStatusUpdate({ txHash: tx.hash });
    const receipt = await tx.wait(1);
    onStatusUpdate({ status: 'confirmed', gasUsed: receipt?.gasUsed.toString() });
    return tx.hash;
  }

  async simulateMint(
    wallet: ethers.Wallet,
    params: MintParams
  ): Promise<{ success: boolean; error?: string; gasEstimate?: bigint }> {
    try {
      const connectedWallet = wallet.connect(this.provider);
      const abi      = params.manualAbi ? JSON.parse(params.manualAbi) : COMMON_MINT_ABI;
      const contract = new ethers.Contract(params.contractAddress, abi, connectedWallet);
      const fragments = contract.interface.fragments.filter(
        f => f.type === 'function' && (f as ethers.FunctionFragment).name === params.functionName
      ) as ethers.FunctionFragment[];
      if (fragments.length === 0) throw new Error(`Function ${params.functionName} not found in ABI`);

      const value = ethers.parseEther((parseFloat(params.mintPrice) * params.quantity).toFixed(18));
      let lastError: any;
      for (const fragment of fragments) {
        try {
          const args      = this.prepareArgs(fragment, params, wallet.address);
          const signature = fragment.format();
          await contract[signature].staticCall(...args, { value });
          const gasEstimate = await contract[signature].estimateGas(...args, { value });
          return { success: true, gasEstimate };
        } catch (e) { lastError = e; }
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
      } else if (input.type === 'bytes32[]') { args.push([]);
      } else if (input.type === 'bytes')     { args.push('0x');
      } else if (input.type === 'string')    { args.push('');
      } else if (input.type === 'address')   { args.push(ethers.ZeroAddress); }
    });
    return args;
  }

  private decodeError(error: any, abi?: string): string {
    let message = error.message || '';

    if (abi && error.data) {
      try {
        const iface   = new ethers.Interface(JSON.parse(abi));
        const decoded = iface.parseError(error.data);
        if (decoded) return `Contract Error: ${decoded.name}(${decoded.args.join(', ')})`;
      } catch { /* ignore */ }
    }

    // SeaDrop-specific errors
    if (message.includes('NotActive') || message.includes('not active'))           return 'SeaDrop: Public drop is not active yet';
    if (message.includes('InvalidFeeRecipient'))                                   return 'SeaDrop: Invalid fee recipient — re-analyze to refresh';
    if (message.includes('MintQuantityExceedsMaxMintedPerWallet'))                 return 'SeaDrop: Max per wallet reached';
    if (message.includes('MintQuantityExceedsMaxSupply'))                          return 'SeaDrop: Sold out / exceeds max supply';
    if (message.includes('FeeRecipientNotAllowed'))                                return 'SeaDrop: Fee recipient not allowed — re-analyze to refresh';

    if (message.includes('insufficient funds'))   return 'Insufficient funds for gas + price';
    if (message.includes('ambiguous function'))   return 'Ambiguous function: provide manual ABI';
    if (message.includes('execution reverted')) {
      if (message.includes('sold out') || message.includes('Sold out'))            return 'Mint sold out';
      if (message.includes('paused') || message.includes('Paused'))               return 'Minting is paused';
      if (message.includes('max supply') || message.includes('MaxSupply'))         return 'Exceeds max supply';
      if (message.includes('not whitelisted') || message.includes('MerkleProof')) return 'Not whitelisted / not eligible';
      if (message.includes('max per wallet') || message.includes('ExceedsWalletLimit')) return 'Max per wallet reached';
      if (message.includes('not started') || message.includes('not live'))        return 'Sale has not started yet';
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
        const wallet  = new ethers.Wallet(privateKey, this.provider);
        const address = wallet.address;

        onStatusUpdate({ address, status: 'preparing' });
        const balance = await this.getBalance(address);
        onStatusUpdate({ balance });

        const totalCost = parseFloat(params.mintPrice) * params.quantity;
        if (parseFloat(balance) < totalCost) throw new Error('Insufficient funds for mint price');

        // ── SeaDrop path ───────────────────────────────────────────────────
        const seaDropInfo = await this.detectSeaDrop(params.contractAddress, this.provider);
        if (seaDropInfo.isSeaDrop && seaDropInfo.seaDropAddress && seaDropInfo.feeRecipient) {
          onStatusUpdate({ status: 'simulating' });
          return await this.executeSeaDropMint(
            wallet, params, seaDropInfo.seaDropAddress, seaDropInfo.feeRecipient, onStatusUpdate
          );
        }

        // ── Standard path ──────────────────────────────────────────────────
        onStatusUpdate({ status: 'simulating' });
        const sim = await this.simulateMint(wallet, params);
        if (!sim.success) throw new Error(sim.error);

        onStatusUpdate({ status: 'executing' });
        const abi      = params.manualAbi ? JSON.parse(params.manualAbi) : COMMON_MINT_ABI;
        const contract = new ethers.Contract(params.contractAddress, abi, wallet);
        const fragments = contract.interface.fragments.filter(
          f => f.type === 'function' && (f as ethers.FunctionFragment).name === params.functionName
        ) as ethers.FunctionFragment[];
        if (fragments.length === 0) throw new Error(`Function ${params.functionName} not found`);

        const value = ethers.parseEther(totalCost.toFixed(18));
        let workingFragment: ethers.FunctionFragment | null = null;
        let workingArgs: any[] = [];

        for (const fragment of fragments) {
          try {
            const args      = this.prepareArgs(fragment, params, address);
            const signature = fragment.format();
            await contract[signature].staticCall(...args, { value });
            workingFragment = fragment;
            workingArgs     = args;
            break;
          } catch { continue; }
        }
        if (!workingFragment) throw new Error(`No valid signature found for ${params.functionName}`);

        const feeData = await this.provider.getFeeData();
        let maxFeePerGas         = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
        let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 0n;

        if (params.gasPreference === 'aggressive') {
          maxPriorityFeePerGas = (maxPriorityFeePerGas * 300n) / 100n;
          maxFeePerGas         = (maxFeePerGas * 220n) / 100n;
        } else if (params.gasPreference === 'standard') {
          maxPriorityFeePerGas = (maxPriorityFeePerGas * 150n) / 100n;
          maxFeePerGas         = (maxFeePerGas * 130n) / 100n;
        }

        const signature = workingFragment.format();
        const tx = await contract[signature](...workingArgs, {
          value, maxFeePerGas, maxPriorityFeePerGas,
          gasLimit: (sim.gasEstimate! * 130n) / 100n,
        });

        onStatusUpdate({ txHash: tx.hash });
        const receipt = await tx.wait(1);
        onStatusUpdate({ status: 'confirmed', gasUsed: receipt?.gasUsed.toString() });
        return tx.hash;

      } catch (error: any) {
        const decodedError = this.decodeError(error, params.manualAbi);
        if (
          attempt < retryCount &&
          !decodedError.includes('Insufficient funds') &&
          !decodedError.includes('Max per wallet') &&
          !decodedError.includes('Sold out') &&
          !decodedError.includes('sold out')
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