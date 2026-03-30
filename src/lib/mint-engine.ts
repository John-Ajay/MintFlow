import { ethers } from 'ethers';
import { MintParams, Network, WalletStatus, ContractInfo } from '../types.ts';

// ─── RPC endpoints ────────────────────────────────────────────────────────────
const RPC_URLS: Record<Network, string[]> = {
  ethereum: [
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
  ],
  base: [
    'https://mainnet.base.org',
    'https://base.llamarpc.com',
    'https://developer-access-mainnet.base.org',
  ],
  polygon:  ['https://polygon.llamarpc.com', 'https://polygon-rpc.com'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.llamarpc.com'],
  optimism: ['https://mainnet.optimism.io',  'https://optimism.llamarpc.com'],
};

// ─── Etherscan V2 — one key works for Ethereum + Base + 60 other EVM chains ──
const ETHERSCAN_API_KEY = '7GAANR2I617ZYIE17XTFE7CPY8GY7BI3IV';
const ETHERSCAN_CHAIN_IDS: Partial<Record<Network, number>> = {
  ethereum: 1,
  base:     8453,
};

// ─── SeaDrop ──────────────────────────────────────────────────────────────────
const SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const SEADROP_NETWORKS: Network[] = ['ethereum', 'base', 'optimism'];

const SEADROP_ABI = [
  'function getPublicDrop(address nftContract) external view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getFeeRecipients(address nftContract) external view returns (address[])',
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) external payable',
];

const SEADROP_NFT_PROBE_ABI = [
  'function getMintStats(address minter) external view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)',
];

// ─── ThirdWeb ─────────────────────────────────────────────────────────────────
const THIRDWEB_DROP_ABI = [
  'function getActiveClaimConditionId() public view returns (uint256)',
  'function getClaimConditionById(uint256 conditionId) public view returns (tuple(uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata))',
  'function claim(address receiver, uint256 quantity, address currency, uint256 pricePerToken, tuple(bytes32[] proof, uint256 quantityLimitPerWallet, uint256 pricePerToken, address currency) allowlistProof, bytes data) public payable',
  'function totalSupply() public view returns (uint256)',
  'function maxTotalSupply() public view returns (uint256)',
  'function nextTokenIdToMint() public view returns (uint256)',
];

// Native token address used by ThirdWeb for ETH price
const THIRDWEB_NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// ─── Fallback ABI for generic ERC721 / ERC1155 drops ─────────────────────────
const GENERIC_MINT_ABI = [
  'function mint(uint256 quantity) public payable',
  'function mint() public payable',
  'function mint(address to, uint256 quantity) public payable',
  'function publicMint(uint256 quantity) public payable',
  'function publicMint() public payable',
  'function purchase(uint256 quantity) public payable',
  'function purchase() public payable',
  'function buy(uint256 quantity) public payable',
  'function freeMint(uint256 quantity) public',
  'function mintFree() public',
  'function totalSupply() public view returns (uint256)',
  'function maxSupply() public view returns (uint256)',
  'function MAX_SUPPLY() public view returns (uint256)',
  'function paused() public view returns (bool)',
  'function saleActive() public view returns (bool)',
  'function publicSaleActive() public view returns (bool)',
  'function mintingEnabled() public view returns (bool)',
  'function price() public view returns (uint256)',
  'function cost() public view returns (uint256)',
  'function mintPrice() public view returns (uint256)',
  'function publicPrice() public view returns (uint256)',
  'function MINT_PRICE() public view returns (uint256)',
  'function getPrice() public view returns (uint256)',
  'function pricePerToken() public view returns (uint256)',
  'function maxPerWallet() public view returns (uint256)',
  'function maxPerTransaction() public view returns (uint256)',
  'function maxMintPerTx() public view returns (uint256)',
  'function MAX_PER_TX() public view returns (uint256)',
  'function maxMintPerWallet() public view returns (uint256)',
  'function MAX_PER_WALLET() public view returns (uint256)',
];

// ─── Types ────────────────────────────────────────────────────────────────────
type ContractType = 'seadrop' | 'thirdweb' | 'generic';

interface DetectedContract {
  type: ContractType;
  abi: any[];
  // SeaDrop specific
  seaDropFeeRecipient?: string;
  // ThirdWeb specific
  thirdwebConditionId?: bigint;
  thirdwebCondition?: any;
}

// ─── Engine ───────────────────────────────────────────────────────────────────
export class MintEngine {
  private providers: ethers.JsonRpcProvider[];
  private currentProviderIndex = 0;
  private network: Network;

  constructor(network: Network) {
    this.network = network;
    this.providers = RPC_URLS[network].map(url => new ethers.JsonRpcProvider(url));
  }

  private get provider() { return this.providers[this.currentProviderIndex]; }

  private rotateProvider() {
    this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
  }

  private async withRetry<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>, retries = 3): Promise<T> {
    let last: any;
    for (let i = 0; i < retries; i++) {
      try { return await fn(this.provider); }
      catch (e) { last = e; this.rotateProvider(); }
    }
    throw last;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  static extractContractAddress(input: string): string {
    const m = input.match(/0x[a-fA-F0-9]{40}/);
    return m ? m[0] : input.trim();
  }

  async getBalance(address: string): Promise<string> {
    return this.withRetry(async p => ethers.formatEther(await p.getBalance(address)));
  }

  async getGasInfo() {
    return this.withRetry(async p => {
      const f = await p.getFeeData();
      const base     = f.gasPrice ?? f.maxFeePerGas ?? 0n;
      const priority = f.maxPriorityFeePerGas ?? 0n;
      return {
        baseFeeGwei:     parseFloat(ethers.formatUnits(base,     'gwei')).toFixed(2),
        priorityFeeGwei: parseFloat(ethers.formatUnits(priority, 'gwei')).toFixed(2),
        totalGwei:       parseFloat(ethers.formatUnits(base + priority, 'gwei')).toFixed(2),
      };
    });
  }

  // ─── Etherscan V2: fetch verified ABI ─────────────────────────────────────
  private async fetchVerifiedAbi(address: string): Promise<any[] | null> {
    const chainId = ETHERSCAN_CHAIN_IDS[this.network];
    if (!chainId) return null;
    try {
      const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_API_KEY}`;
      const res  = await fetch(url);
      const json = await res.json();
      if (json.status === '1' && json.result && json.result !== 'Contract source code not verified') {
        return JSON.parse(json.result);
      }
    } catch { /* non-fatal */ }
    return null;
  }

  // ─── SeaDrop detection ────────────────────────────────────────────────────
  private async detectSeaDrop(address: string, p: ethers.JsonRpcProvider): Promise<{
    detected: boolean;
    feeRecipient?: string;
    mintPrice?: string;
    priceWei?: string;
    maxPerWallet?: number;
    isPaused?: boolean;
    totalSupply?: number;
    maxSupply?: number;
  }> {
    if (!SEADROP_NETWORKS.includes(this.network)) return { detected: false };
    try {
      // Probe: getMintStats only exists on SeaDrop NFT contracts
      const probe = new ethers.Contract(address, SEADROP_NFT_PROBE_ABI, p);
      const stats = await probe.getMintStats(ethers.ZeroAddress);

      const seaDrop = new ethers.Contract(SEADROP_ADDRESS, SEADROP_ABI, p);
      const [dropResult, feeResult] = await Promise.allSettled([
        seaDrop.getPublicDrop(address),
        seaDrop.getFeeRecipients(address),
      ]);

      let mintPrice: string | undefined;
      let priceWei:  string | undefined;
      let maxPerWallet: number | undefined;
      let isPaused = false;

      if (dropResult.status === 'fulfilled') {
        const d = dropResult.value;
        priceWei     = d.mintPrice.toString();
        mintPrice    = ethers.formatEther(d.mintPrice);
        maxPerWallet = Number(d.maxTotalMintableByWallet);
        const now    = Math.floor(Date.now() / 1000);
        isPaused     = Number(d.startTime) > now || (Number(d.endTime) > 0 && Number(d.endTime) < now);
      }

      const feeRecipient = (feeResult.status === 'fulfilled' && feeResult.value.length > 0)
        ? feeResult.value[0]
        : '0x0000a26b00c1F0DF003000390027140000fAa719'; // OpenSea fallback

      return {
        detected: true,
        feeRecipient,
        mintPrice,
        priceWei,
        maxPerWallet,
        isPaused,
        totalSupply: Number(stats.currentTotalSupply),
        maxSupply:   Number(stats.maxSupply),
      };
    } catch {
      return { detected: false };
    }
  }

  // ─── ThirdWeb detection ───────────────────────────────────────────────────
  private async detectThirdWeb(address: string, p: ethers.JsonRpcProvider): Promise<{
    detected: boolean;
    conditionId?: bigint;
    condition?: any;
    mintPrice?: string;
    priceWei?: string;
    maxPerWallet?: number;
    isPaused?: boolean;
    totalSupply?: number;
    maxSupply?: number;
  }> {
    try {
      const contract = new ethers.Contract(address, THIRDWEB_DROP_ABI, p);
      const conditionId = await contract.getActiveClaimConditionId();
      const condition   = await contract.getClaimConditionById(conditionId);

      const mintPrice = ethers.formatEther(condition.pricePerToken);
      const priceWei  = condition.pricePerToken.toString();
      const now       = Math.floor(Date.now() / 1000);
      const isPaused  = Number(condition.startTimestamp) > now;
      const maxPerWallet = Number(condition.quantityLimitPerWallet);

      const [supplyResult, maxSupplyResult, nextTokenResult] = await Promise.allSettled([
        contract.totalSupply(),
        contract.maxTotalSupply(),
        contract.nextTokenIdToMint(),
      ]);

      const totalSupply = supplyResult.status === 'fulfilled'    ? Number(supplyResult.value)   : undefined;
      const maxSupply   = maxSupplyResult.status === 'fulfilled' ? Number(maxSupplyResult.value) :
                          nextTokenResult.status === 'fulfilled' ? Number(nextTokenResult.value) : undefined;

      return { detected: true, conditionId, condition, mintPrice, priceWei, maxPerWallet, isPaused, totalSupply, maxSupply };
    } catch {
      return { detected: false };
    }
  }

  // ─── Main analysis ────────────────────────────────────────────────────────
  async analyzeContract(address: string, manualAbi?: string): Promise<ContractInfo> {
    return this.withRetry(async p => {
      const info: ContractInfo = {
        address,
        abi: [],
        isVerified: false,
      };

      // 1. SeaDrop check (fastest — no ABI needed)
      const sd = await this.detectSeaDrop(address, p);
      if (sd.detected) {
        info.contractType        = 'seadrop';
        info.isSeaDrop           = true;
        info.seaDropAddress      = SEADROP_ADDRESS;
        info.seaDropFeeRecipient = sd.feeRecipient;
        info.mintFunction        = 'mintPublic';
        info.currentPhase        = 'Public Drop (SeaDrop)';
        info.minQuantity         = 1;
        if (sd.mintPrice !== undefined) { info.price = sd.mintPrice; info.priceWei = sd.priceWei; }
        if (sd.maxPerWallet)            info.maxQuantity = sd.maxPerWallet;
        if (sd.isPaused !== undefined)  info.isPaused    = sd.isPaused;
        if (sd.totalSupply !== undefined) info.totalSupply = sd.totalSupply;
        if (sd.maxSupply !== undefined)   info.maxSupply   = sd.maxSupply;
        try { info.gasInfo = await this.getGasInfo(); } catch {}
        return info;
      }

      // 2. ThirdWeb check
      const tw = await this.detectThirdWeb(address, p);
      if (tw.detected) {
        // Try to get full verified ABI from Etherscan too
        const verifiedAbi = manualAbi ? JSON.parse(manualAbi) : await this.fetchVerifiedAbi(address);
        info.abi          = verifiedAbi ?? THIRDWEB_DROP_ABI;
        info.isVerified   = !!verifiedAbi;
        info.contractType = 'thirdweb';
        info.mintFunction = 'claim';
        info.currentPhase = `Phase ${tw.conditionId?.toString() ?? '0'}`;
        info.minQuantity  = 1;
        info.thirdwebConditionId = tw.conditionId?.toString();
        info.thirdwebCondition   = tw.condition;
        if (tw.mintPrice !== undefined) { info.price = tw.mintPrice; info.priceWei = tw.priceWei; }
        if (tw.maxPerWallet)            info.maxQuantity = tw.maxPerWallet;
        if (tw.isPaused !== undefined)  info.isPaused    = tw.isPaused;
        if (tw.totalSupply !== undefined) info.totalSupply = tw.totalSupply;
        if (tw.maxSupply !== undefined)   info.maxSupply   = tw.maxSupply;
        try { info.gasInfo = await this.getGasInfo(); } catch {}
        return info;
      }

      // 3. Generic — try Etherscan verified ABI first, then fallback
      const verifiedAbi = manualAbi ? JSON.parse(manualAbi) : await this.fetchVerifiedAbi(address);
      info.abi        = verifiedAbi ?? GENERIC_MINT_ABI;
      info.isVerified = !!verifiedAbi;
      info.contractType = 'generic';

      const contract = new ethers.Contract(address, info.abi, p);

      const [
        totalSupply, maxSupply, MAX_SUPPLY,
        paused, saleActive, publicSaleActive, mintingEnabled,
        price, cost, mintPrice, publicPrice, MINT_PRICE, getPrice, pricePerToken,
        maxPerWallet, maxPerTx, MAX_PER_TX, MAX_PER_WALLET,
      ] = await Promise.allSettled([
        contract.totalSupply(), contract.maxSupply(), contract.MAX_SUPPLY(),
        contract.paused(), contract.saleActive(), contract.publicSaleActive(), contract.mintingEnabled(),
        contract.price(), contract.cost(), contract.mintPrice(), contract.publicPrice(),
        contract.MINT_PRICE(), contract.getPrice(), contract.pricePerToken(),
        contract.maxPerWallet(), contract.maxPerTransaction?.() ?? Promise.reject(),
        contract.MAX_PER_TX?.() ?? Promise.reject(), contract.MAX_PER_WALLET?.() ?? Promise.reject(),
      ]);

      // Supply
      const supplyVal = [totalSupply].find(r => r.status === 'fulfilled');
      if (supplyVal?.status === 'fulfilled') info.totalSupply = Number(supplyVal.value);
      const maxVal = [maxSupply, MAX_SUPPLY].find(r => r.status === 'fulfilled');
      if (maxVal?.status === 'fulfilled') info.maxSupply = Number(maxVal.value);

      // Pause
      if (paused.status === 'fulfilled')            info.isPaused = Boolean(paused.value);
      else if (publicSaleActive.status === 'fulfilled') info.isPaused = !publicSaleActive.value;
      else if (saleActive.status === 'fulfilled')   info.isPaused = !saleActive.value;
      else if (mintingEnabled.status === 'fulfilled') info.isPaused = !mintingEnabled.value;

      // Price — pick first non-zero
      for (const r of [price, cost, mintPrice, publicPrice, MINT_PRICE, getPrice, pricePerToken]) {
        if (r.status === 'fulfilled' && r.value !== undefined) {
          const f = ethers.formatEther(r.value);
          if (parseFloat(f) >= 0) { info.price = f; info.priceWei = r.value.toString(); break; }
        }
      }

      // Quantity limits
      info.minQuantity = 1;
      for (const r of [maxPerTx, MAX_PER_TX, maxPerWallet, MAX_PER_WALLET]) {
        if (r.status === 'fulfilled' && Number(r.value) > 0) { info.maxQuantity = Number(r.value); break; }
      }

      // Mint function detection from ABI
      for (const fn of ['mint', 'publicMint', 'purchase', 'buy', 'freeMint', 'mintFree']) {
        const frags = contract.interface.fragments.filter(
          f => f.type === 'function' && (f as ethers.FunctionFragment).name === fn
        );
        if (frags.length > 0) { info.mintFunction = fn; break; }
      }

      try { info.gasInfo = await this.getGasInfo(); } catch {}
      return info;
    });
  }

  // ─── Execute mint — routes automatically ─────────────────────────────────
  async executeMint(
    privateKey: string,
    params: MintParams,
    onStatusUpdate: (s: Partial<WalletStatus>) => void,
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

        // Detect contract type
        onStatusUpdate({ status: 'simulating' });
        const sd = await this.detectSeaDrop(params.contractAddress, this.provider);
        if (sd.detected && sd.feeRecipient) {
          return await this._mintSeaDrop(wallet, params, sd.feeRecipient, totalCost, onStatusUpdate);
        }

        const tw = await this.detectThirdWeb(params.contractAddress, this.provider);
        if (tw.detected && tw.condition) {
          return await this._mintThirdWeb(wallet, params, tw.condition, totalCost, onStatusUpdate);
        }

        return await this._mintGeneric(wallet, params, totalCost, onStatusUpdate);

      } catch (err: any) {
        const msg = this.decodeError(err, params.manualAbi);
        const fatal = msg.includes('Insufficient funds') || msg.includes('Max per wallet') || msg.includes('old out');
        if (!fatal && attempt < retryCount) {
          attempt++;
          await new Promise(r => setTimeout(r, 700 * attempt));
          continue;
        }
        onStatusUpdate({ status: 'failed', error: msg });
        throw new Error(msg);
      }
    }
    throw new Error('Max retries reached');
  }

  // ─── SeaDrop mint ─────────────────────────────────────────────────────────
  private async _mintSeaDrop(
    wallet: ethers.Wallet,
    params: MintParams,
    feeRecipient: string,
    totalCost: number,
    onStatusUpdate: (s: Partial<WalletStatus>) => void
  ): Promise<string> {
    const seaDrop = new ethers.Contract(SEADROP_ADDRESS, SEADROP_ABI, wallet);
    const value   = ethers.parseEther(totalCost.toFixed(18));

    // Static call to confirm it will pass
    try {
      await seaDrop.mintPublic.staticCall(
        params.contractAddress, feeRecipient, wallet.address, params.quantity, { value }
      );
    } catch (e: any) { throw new Error(this.decodeError(e)); }

    const gasEstimate = await seaDrop.mintPublic.estimateGas(
      params.contractAddress, feeRecipient, wallet.address, params.quantity, { value }
    );

    const { maxFeePerGas, maxPriorityFeePerGas } = await this._gasFees(params.gasPreference);
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

  // ─── ThirdWeb mint ────────────────────────────────────────────────────────
  private async _mintThirdWeb(
    wallet: ethers.Wallet,
    params: MintParams,
    condition: any,
    totalCost: number,
    onStatusUpdate: (s: Partial<WalletStatus>) => void
  ): Promise<string> {
    // Fetch full ABI — try Etherscan first then fallback
    const verifiedAbi = params.manualAbi
      ? JSON.parse(params.manualAbi)
      : await this.fetchVerifiedAbi(params.contractAddress) ?? THIRDWEB_DROP_ABI;

    const contract = new ethers.Contract(params.contractAddress, verifiedAbi, wallet);
    const value    = ethers.parseEther(totalCost.toFixed(18));

    // ThirdWeb claim args:
    // claim(receiver, quantity, currency, pricePerToken, allowlistProof, data)
    const allowlistProof = {
      proof:                    [],
      quantityLimitPerWallet:   condition.quantityLimitPerWallet,
      pricePerToken:            condition.pricePerToken,
      currency:                 condition.currency,
    };

    const claimArgs = [
      wallet.address,          // receiver
      params.quantity,          // quantity
      condition.currency,       // currency (native token or ERC20)
      condition.pricePerToken,  // pricePerToken
      allowlistProof,           // allowlistProof (empty for public mint)
      '0x',                     // data
    ];

    // Static simulation
    try {
      await contract.claim.staticCall(...claimArgs, { value });
    } catch (e: any) { throw new Error(this.decodeError(e, params.manualAbi)); }

    const gasEstimate = await contract.claim.estimateGas(...claimArgs, { value });
    const { maxFeePerGas, maxPriorityFeePerGas } = await this._gasFees(params.gasPreference);

    onStatusUpdate({ status: 'executing' });
    const tx = await contract.claim(...claimArgs, {
      value, maxFeePerGas, maxPriorityFeePerGas, gasLimit: (gasEstimate * 130n) / 100n
    });
    onStatusUpdate({ txHash: tx.hash });
    const receipt = await tx.wait(1);
    onStatusUpdate({ status: 'confirmed', gasUsed: receipt?.gasUsed.toString() });
    return tx.hash;
  }

  // ─── Generic mint ─────────────────────────────────────────────────────────
  private async _mintGeneric(
    wallet: ethers.Wallet,
    params: MintParams,
    totalCost: number,
    onStatusUpdate: (s: Partial<WalletStatus>) => void
  ): Promise<string> {
    const verifiedAbi = params.manualAbi
      ? JSON.parse(params.manualAbi)
      : await this.fetchVerifiedAbi(params.contractAddress) ?? GENERIC_MINT_ABI;

    const contract  = new ethers.Contract(params.contractAddress, verifiedAbi, wallet);
    const value     = ethers.parseEther(totalCost.toFixed(18));

    const fragments = contract.interface.fragments.filter(
      f => f.type === 'function' && (f as ethers.FunctionFragment).name === params.functionName
    ) as ethers.FunctionFragment[];
    if (fragments.length === 0) throw new Error(`Function "${params.functionName}" not found — try providing manual ABI`);

    // Try each overload until one simulates successfully
    let workingFragment: ethers.FunctionFragment | null = null;
    let workingArgs: any[] = [];
    let gasEstimate: bigint = 200000n;
    let lastErr: any;

    for (const frag of fragments) {
      try {
        const args = this._prepareArgs(frag, params, wallet.address);
        const sig  = frag.format();
        await contract[sig].staticCall(...args, { value });
        gasEstimate     = await contract[sig].estimateGas(...args, { value });
        workingFragment = frag;
        workingArgs     = args;
        break;
      } catch (e) { lastErr = e; }
    }

    if (!workingFragment) throw lastErr ?? new Error(`All overloads of "${params.functionName}" reverted`);

    const { maxFeePerGas, maxPriorityFeePerGas } = await this._gasFees(params.gasPreference);
    onStatusUpdate({ status: 'executing' });

    const sig = workingFragment.format();
    const tx  = await contract[sig](...workingArgs, {
      value, maxFeePerGas, maxPriorityFeePerGas, gasLimit: (gasEstimate * 130n) / 100n
    });
    onStatusUpdate({ txHash: tx.hash });
    const receipt = await tx.wait(1);
    onStatusUpdate({ status: 'confirmed', gasUsed: receipt?.gasUsed.toString() });
    return tx.hash;
  }

  // ─── Gas fees with strategy ───────────────────────────────────────────────
  private async _gasFees(preference: MintParams['gasPreference']) {
    const f = await this.provider.getFeeData();
    let maxFeePerGas         = f.maxFeePerGas  ?? f.gasPrice ?? 0n;
    let maxPriorityFeePerGas = f.maxPriorityFeePerGas ?? 0n;

    if (preference === 'aggressive') {
      maxPriorityFeePerGas = (maxPriorityFeePerGas * 300n) / 100n;
      maxFeePerGas         = (maxFeePerGas * 220n) / 100n;
    } else if (preference === 'standard') {
      maxPriorityFeePerGas = (maxPriorityFeePerGas * 150n) / 100n;
      maxFeePerGas         = (maxFeePerGas * 130n) / 100n;
    }
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  // ─── Prepare args for generic contracts ──────────────────────────────────
  private _prepareArgs(frag: ethers.FunctionFragment, params: MintParams, walletAddress: string): any[] {
    const args: any[] = [];
    frag.inputs.forEach(input => {
      const name = (input.name || '').toLowerCase();
      if (['quantity', '_quantity', 'amount', '_amount', 'count', 'numberOfTokens'].includes(name)) {
        args.push(params.quantity);
      } else if (input.type === 'address' && ['receiver','to','_to','user','_user','recipient'].includes(name)) {
        args.push(walletAddress);
      } else if (input.type === 'uint256') {
        args.push(frag.inputs.length === 1 ? params.quantity : 0);
      } else if (input.type === 'bytes32[]') { args.push([]);
      } else if (input.type === 'bytes')     { args.push('0x');
      } else if (input.type === 'string')    { args.push('');
      } else if (input.type === 'address')   { args.push(ethers.ZeroAddress);
      } else if (input.type === 'bool')      { args.push(false); }
    });
    return args;
  }

  // ─── Error decoder ────────────────────────────────────────────────────────
  private decodeError(error: any, abi?: string): string {
    const msg = error.message || '';

    // Try to decode custom error using ABI
    if (error.data && abi) {
      try {
        const decoded = new ethers.Interface(JSON.parse(abi)).parseError(error.data);
        if (decoded) return `Contract error: ${decoded.name}(${decoded.args.join(', ')})`;
      } catch {}
    }

    // SeaDrop specific
    if (msg.includes('NotActive'))                        return 'SeaDrop: Drop is not active yet';
    if (msg.includes('InvalidFeeRecipient') || msg.includes('FeeRecipientNotAllowed'))
                                                          return 'SeaDrop: Invalid fee recipient — re-analyze';
    if (msg.includes('MintQuantityExceedsMaxMintedPerWallet')) return 'SeaDrop: Max per wallet reached';
    if (msg.includes('MintQuantityExceedsMaxSupply'))     return 'SeaDrop: Sold out';

    // ThirdWeb specific
    if (msg.includes('!Qty'))                            return 'ThirdWeb: Invalid quantity';
    if (msg.includes('!PriceOrCurrency'))                return 'ThirdWeb: Price or currency mismatch — re-analyze';
    if (msg.includes('!MaxSupply'))                      return 'ThirdWeb: Exceeds max supply';
    if (msg.includes('cant claim yet'))                  return 'ThirdWeb: Claim not started yet';
    if (msg.includes('exceed limit'))                    return 'ThirdWeb: Wallet limit reached';

    // Generic
    if (msg.includes('insufficient funds'))              return 'Insufficient funds for gas + mint price';
    if (msg.includes('execution reverted')) {
      if (msg.includes('sold out') || msg.includes('Sold out'))  return 'Sold out';
      if (msg.includes('paused') || msg.includes('Paused'))      return 'Minting is paused';
      if (msg.includes('max supply'))                             return 'Exceeds max supply';
      if (msg.includes('not whitelisted') || msg.includes('MerkleProof')) return 'Not whitelisted';
      if (msg.includes('max per wallet'))                         return 'Max per wallet reached';
      const reason = msg.split('reverted: ')[1];
      if (reason) return `Reverted: ${reason.split('\n')[0]}`;
      if (error.data?.startsWith?.('0x')) return `Reverted (raw): ${error.data.slice(0, 10)}... — provide manual ABI`;
      return 'Reverted: Unknown reason — check if mint is live';
    }
    return msg || 'Unknown error';
  }
}
