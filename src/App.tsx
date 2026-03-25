import React, { useState, useEffect, useRef } from 'react';
import { 
  Shield, 
  Wallet, 
  Zap, 
  Settings, 
  Play, 
  Pause, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  Loader2,
  Terminal,
  Cpu,
  Activity,
  Globe,
  Plus,
  Trash2,
  ExternalLink
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { MintEngine } from './lib/mint-engine';
import { MintParams, WalletStatus, MintLog, Network, ContractInfo } from './types.ts';
import { cn } from './lib/utils';

export default function App() {
  const [params, setParams] = useState<MintParams>({
    contractAddress: '',
    network: 'ethereum',
    functionName: 'mint',
    args: [],
    mintPrice: '0',
    quantity: 1,
    gasPreference: 'standard',
    manualAbi: ''
  });

  const [contractInfo, setContractInfo] = useState<ContractInfo | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [privateKeys, setPrivateKeys] = useState<string>('');
  const [wallets, setWallets] = useState<WalletStatus[]>([]);
  const [logs, setLogs] = useState<MintLog[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [showSecurityWarning, setShowSecurityWarning] = useState(true);

  const logEndRef = useRef<HTMLDivElement>(null);

  const getExplorerUrl = (network: Network) => {
    switch (network) {
      case 'ethereum': return 'https://etherscan.io';
      case 'polygon': return 'https://polygonscan.com';
      case 'base': return 'https://basescan.org';
      case 'arbitrum': return 'https://arbiscan.io';
      case 'optimism': return 'https://optimistic.etherscan.io';
      default: return 'https://etherscan.io';
    }
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = (message: string, type: MintLog['type'] = 'info', wallet?: string) => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date(),
      message,
      type,
      wallet: wallet || 'System'
    }]);
  };

  const analyzeContract = async () => {
    if (!params.contractAddress) {
      addLog('Enter contract address first', 'warning');
      return;
    }
    setIsAnalyzing(true);
    addLog(`Analyzing contract on ${params.network}...`, 'info');
    try {
      const engine = new MintEngine(params.network);
      const info = await engine.analyzeContract(params.contractAddress, params.manualAbi);
      setContractInfo(info);
      
      if (info.mintFunction) {
        setParams(prev => ({ ...prev, functionName: info.mintFunction! }));
        addLog(`Detected mint function: ${info.mintFunction}`, 'success');
      }
      if (info.price) {
        setParams(prev => ({ ...prev, mintPrice: info.price! }));
        addLog(`Detected mint price: ${info.price} ETH`, 'success');
      }
      if (info.isPaused) {
        addLog('Warning: Contract reports minting is PAUSED', 'warning');
      }
      if (info.totalSupply !== undefined && info.maxSupply !== undefined) {
        addLog(`Supply: ${info.totalSupply} / ${info.maxSupply}`, 'info');
      }
    } catch (err: any) {
      addLog(`Analysis failed: ${err.message}`, 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const startMinting = async () => {
    const keys = privateKeys.split('\n').map(k => k.trim()).filter(k => k.length > 0);
    if (keys.length === 0) {
      addLog('No private keys provided', 'error');
      return;
    }

    if (!params.contractAddress) {
      addLog('Contract address is required', 'error');
      return;
    }

    setIsExecuting(true);
    addLog(`Starting minting process on ${params.network}...`, 'info');

    const engine = new MintEngine(params.network);
    const initialWallets: WalletStatus[] = keys.map(k => ({
      address: 'Initializing...',
      balance: '0',
      status: 'idle'
    }));
    setWallets(initialWallets);

    // Controlled sequential execution
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      try {
        await engine.executeMint(key, params, (update) => {
          setWallets(prev => {
            const next = [...prev];
            next[i] = { ...next[i], ...update };
            return next;
          });
          
          if (update.status === 'executing') addLog(`Executing mint for wallet ${i + 1}...`, 'info');
          if (update.status === 'confirmed') addLog(`Mint confirmed for wallet ${i + 1}! Gas: ${update.gasUsed}`, 'success');
          if (update.status === 'failed') addLog(`Mint failed for wallet ${i + 1}: ${update.error}`, 'error');
        });
      } catch (err: any) {
        addLog(`Wallet ${i + 1} fatal error: ${err.message}`, 'error');
      }
      // Small delay between wallets to prevent RPC spam
      await new Promise(r => setTimeout(r, 500));
    }

    setIsExecuting(false);
    addLog('Batch minting process completed.', 'info');
  };

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 glass-panel p-6 bg-gradient-to-r from-card to-bg">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-accent/10 rounded-lg">
            <Cpu className="w-8 h-8 text-accent" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">MINTFLOW <span className="text-accent text-xs font-mono ml-2">v2.0.0</span></h1>
            <p className="text-zinc-500 text-sm">Advanced Multi-Wallet Minting Agent</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 rounded-full border border-border">
            <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-xs font-mono uppercase tracking-wider text-zinc-400">Network: {params.network}</span>
          </div>
          <button 
            onClick={() => setShowSecurityWarning(!showSecurityWarning)}
            className="p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400"
          >
            <Shield className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Security Warning */}
      <AnimatePresence>
        {showSecurityWarning && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-4">
              <AlertTriangle className="w-6 h-6 text-red-500 shrink-0 mt-1" />
              <div className="space-y-1">
                <h3 className="font-bold text-red-500">SECURITY PROTOCOL WARNING</h3>
                <p className="text-sm text-zinc-400">
                  This tool requires private keys for automated execution. 
                  <span className="text-zinc-200 font-medium"> NEVER use your primary vault wallets.</span> 
                  Always use fresh burner wallets with only the necessary funds for the mint. 
                  Keys are handled only in memory and never stored, but your browser environment is your responsibility.
                </p>
              </div>
              <button onClick={() => setShowSecurityWarning(false)} className="ml-auto text-zinc-500 hover:text-zinc-300">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Configuration */}
        <div className="lg:col-span-5 space-y-6">
          {/* Mint Parameters */}
          <section className="glass-panel p-6 space-y-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Settings className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-400">Configuration</h2>
              </div>
              {contractInfo && (
                <div className="flex items-center gap-2 text-[10px] font-mono">
                  <span className={cn(contractInfo.isPaused ? "text-red-500" : "text-accent")}>
                    {contractInfo.isPaused ? "PAUSED" : "LIVE"}
                  </span>
                  {contractInfo.totalSupply !== undefined && (
                    <span className="text-zinc-500">
                      {contractInfo.totalSupply}/{contractInfo.maxSupply}
                    </span>
                  )}
                </div>
              )}
            </div>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-mono text-zinc-500 uppercase">Target Network</label>
                <select 
                  value={params.network}
                  onChange={(e) => setParams({...params, network: e.target.value as Network})}
                  className="w-full bg-bg border border-border rounded-lg p-2.5 text-sm focus:outline-none focus:border-accent transition-colors"
                >
                  <option value="ethereum">Ethereum Mainnet</option>
                  <option value="polygon">Polygon POS</option>
                  <option value="base">Base Mainnet</option>
                  <option value="arbitrum">Arbitrum One</option>
                  <option value="optimism">Optimism</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-mono text-zinc-500 uppercase">Contract Address</label>
                <div className="flex gap-2">
                  <input 
                    type="text"
                    placeholder="0x..."
                    value={params.contractAddress}
                    onChange={(e) => setParams({...params, contractAddress: e.target.value})}
                    className="flex-1 bg-bg border border-border rounded-lg p-2.5 text-sm font-mono focus:outline-none focus:border-accent transition-colors"
                  />
                  <button 
                    onClick={analyzeContract}
                    disabled={isAnalyzing}
                    className="px-4 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs font-bold transition-colors disabled:opacity-50"
                  >
                    {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : "ANALYZE"}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-mono text-zinc-500 uppercase">Manual ABI (Optional)</label>
                <textarea 
                  placeholder='[{"inputs":[],"name":"mint",...}]'
                  value={params.manualAbi}
                  onChange={(e) => setParams({...params, manualAbi: e.target.value})}
                  className="w-full h-20 bg-bg border border-border rounded-lg p-2.5 text-[10px] font-mono focus:outline-none focus:border-accent transition-colors resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-mono text-zinc-500 uppercase">Function Name</label>
                  <input 
                    type="text"
                    placeholder="mint"
                    value={params.functionName}
                    onChange={(e) => setParams({...params, functionName: e.target.value})}
                    className="w-full bg-bg border border-border rounded-lg p-2.5 text-sm font-mono focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-mono text-zinc-500 uppercase">Quantity</label>
                  <input 
                    type="number"
                    min="1"
                    value={params.quantity}
                    onChange={(e) => setParams({...params, quantity: parseInt(e.target.value)})}
                    className="w-full bg-bg border border-border rounded-lg p-2.5 text-sm focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-mono text-zinc-500 uppercase">Price (Native)</label>
                  <input 
                    type="text"
                    placeholder="0.05"
                    value={params.mintPrice}
                    onChange={(e) => setParams({...params, mintPrice: e.target.value})}
                    className="w-full bg-bg border border-border rounded-lg p-2.5 text-sm font-mono focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-mono text-zinc-500 uppercase">Gas Strategy</label>
                  <select 
                    value={params.gasPreference}
                    onChange={(e) => setParams({...params, gasPreference: e.target.value as any})}
                    className="w-full bg-bg border border-border rounded-lg p-2.5 text-sm focus:outline-none focus:border-accent transition-colors"
                  >
                    <option value="low">Low (Patient)</option>
                    <option value="standard">Standard</option>
                    <option value="aggressive">Aggressive (Fast)</option>
                  </select>
                </div>
              </div>
            </div>
          </section>

          {/* Wallet Input */}
          <section className="glass-panel p-6 space-y-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-400">Wallets</h2>
              </div>
              <span className="text-[10px] font-mono text-zinc-600">ONE PRIVATE KEY PER LINE</span>
            </div>
            
            <textarea 
              value={privateKeys}
              onChange={(e) => setPrivateKeys(e.target.value)}
              placeholder="Enter private keys..."
              className="w-full h-40 bg-bg border border-border rounded-lg p-3 text-xs font-mono focus:outline-none focus:border-accent transition-colors resize-none"
            />
            
            <button 
              onClick={startMinting}
              disabled={isExecuting}
              className={cn(
                "w-full py-3 rounded-lg font-bold flex items-center justify-center gap-2 transition-all",
                isExecuting 
                  ? "bg-zinc-800 text-zinc-500 cursor-not-allowed" 
                  : "bg-accent text-bg hover:shadow-[0_0_20px_rgba(0,255,136,0.3)] active:scale-[0.98]"
              )}
            >
              {isExecuting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  EXECUTING BATCH...
                </>
              ) : (
                <>
                  <Zap className="w-5 h-5 fill-current" />
                  INITIALIZE MINT
                </>
              )}
            </button>
          </section>
        </div>

        {/* Right Column: Execution & Logs */}
        <div className="lg:col-span-7 space-y-6">
          {/* Live Status Grid */}
          <section className="glass-panel p-6 min-h-[300px] flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-400">Execution Status</h2>
              </div>
              <div className="flex gap-4 text-[10px] font-mono uppercase">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-accent" />
                  <span className="text-zinc-400">Success: {wallets.filter(w => w.status === 'confirmed').length}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-red-500" />
                  <span className="text-zinc-400">Failed: {wallets.filter(w => w.status === 'failed').length}</span>
                </div>
              </div>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto max-h-[400px] pr-2 custom-scrollbar">
              {wallets.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-zinc-600 space-y-2">
                  <Terminal className="w-12 h-12 opacity-20" />
                  <p className="text-xs font-mono">WAITING FOR INITIALIZATION...</p>
                </div>
              ) : (
                wallets.map((wallet, idx) => (
                  <div key={idx} className="p-3 bg-bg/50 border border-border rounded-lg flex items-center justify-between group hover:border-accent/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded bg-zinc-900 border border-border flex items-center justify-center text-[10px] font-mono text-zinc-500">
                        {idx + 1}
                      </div>
                      <div className="space-y-0.5">
                        <p className="text-xs font-mono text-zinc-300 truncate max-w-[150px] md:max-w-[250px]">
                          {wallet.address}
                        </p>
                        <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-mono">
                          <span>Balance: {wallet.balance} ETH</span>
                          {wallet.gasUsed && <span className="text-accent/60">Gas: {wallet.gasUsed}</span>}
                          {wallet.txHash && (
                            <a 
                              href={`${getExplorerUrl(params.network)}/tx/${wallet.txHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-accent hover:underline flex items-center gap-1"
                            >
                              TX <ExternalLink className="w-2 h-2" />
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {wallet.status === 'skipped' && (
                        <div className="px-2 py-0.5 bg-zinc-800 text-zinc-500 rounded text-[10px] font-mono uppercase">
                          SKIPPED
                        </div>
                      )}
                      <div className={cn(
                        "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider flex items-center gap-2",
                        wallet.status === 'confirmed' ? "bg-accent/10 text-accent" :
                        wallet.status === 'failed' ? "bg-red-500/10 text-red-500" :
                        wallet.status === 'executing' ? "bg-blue-500/10 text-blue-500" :
                        wallet.status === 'preparing' ? "bg-zinc-800 text-zinc-400" :
                        "bg-zinc-900 text-zinc-600"
                      )}>
                        {wallet.status}
                        {wallet.status === 'executing' && <Loader2 className="w-3 h-3 animate-spin" />}
                        {wallet.status === 'confirmed' && <CheckCircle2 className="w-3 h-3" />}
                        {wallet.status === 'failed' && <XCircle className="w-3 h-3" />}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Console Logs */}
          <section className="glass-panel bg-black/40 border-zinc-800 flex flex-col h-[300px]">
            <div className="p-3 border-b border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="w-3 h-3 text-zinc-500" />
                <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">System Console</span>
              </div>
              <button 
                onClick={() => setLogs([])}
                className="text-[10px] font-mono text-zinc-600 hover:text-zinc-400"
              >
                CLEAR
              </button>
            </div>
            <div className="flex-1 p-4 font-mono text-[11px] overflow-y-auto space-y-1.5 custom-scrollbar">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-3">
                  <span className="text-zinc-700 shrink-0">[{log.timestamp.toLocaleTimeString()}]</span>
                  <span className={cn(
                    "shrink-0 uppercase font-bold",
                    log.type === 'info' && "text-blue-500",
                    log.type === 'success' && "text-accent",
                    log.type === 'error' && "text-red-500",
                    log.type === 'warning' && "text-yellow-500"
                  )}>
                    {log.type}
                  </span>
                  <span className="text-zinc-400">{log.message}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </section>
        </div>
      </div>

      {/* Footer */}
      <footer className="flex items-center justify-between px-6 py-4 text-[10px] font-mono text-zinc-600 border-t border-border/50">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Globe className="w-3 h-3" />
            <span>NODES: OPTIMIZED</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Shield className="w-3 h-3" />
            <span>ENCRYPTION: AES-256</span>
          </div>
        </div>
        <div>
          © 2026 MINTFLOW PROTOCOL
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #3f3f46;
        }
      `}</style>
    </div>
  );
}
