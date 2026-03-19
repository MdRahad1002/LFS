/**
 * wallet.js — Last Flag Standing
 * Unified wallet connection module for the browser.
 * Supports: MetaMask (injected), WalletConnect v2, Coinbase Wallet.
 *
 * Usage:
 *   import Wallet from '/wallet.js';
 *   const wallet = new Wallet();
 *   await wallet.connect('metamask');      // or 'walletconnect' or 'coinbase'
 *   const token = await wallet.signIn();   // SIWE → backend JWT
 *
 * Events dispatched on window:
 *   wallet:connected      { address, chain }
 *   wallet:disconnected
 *   wallet:chainChanged   { chain }
 *   wallet:accountChanged { address }
 *   wallet:signedIn       { player, token }
 */

const API_BASE = window.API_BASE || '';

class Wallet {
  constructor() {
    this.provider  = null;   // ethers.BrowserProvider
    this.signer    = null;
    this.address   = null;
    this.chainId   = null;
    this.token     = null;   // JWT from backend
    this.player    = null;   // player profile

    // Restore session from localStorage
    this._restoreSession();
  }

  // ─────────────────────────────────────────────────────────
  //  CONNECT
  // ─────────────────────────────────────────────────────────
  async connect(type = 'metamask') {
    if (type === 'metamask') {
      await this._connectMetaMask();
    } else if (type === 'walletconnect') {
      await this._connectWalletConnect();
    } else if (type === 'coinbase') {
      await this._connectCoinbase();
    } else {
      throw new Error('Unknown wallet type: ' + type);
    }
    this._setupListeners();
    window.dispatchEvent(new CustomEvent('wallet:connected', {
      detail: { address: this.address, chain: this.chainId }
    }));
    return { address: this.address, chainId: this.chainId };
  }

  // ─────────────────────────────────────────────────────────
  //  SIGN IN (SIWE)
  // ─────────────────────────────────────────────────────────
  async signIn(referralCode) {
    if (!this.address) throw new Error('Connect wallet first');

    // 1. Get nonce from backend
    const nonceResp = await fetch(API_BASE + '/api/auth/nonce', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ address: this.address }),
    });
    const { message, nonce } = await nonceResp.json();
    if (!nonce) throw new Error('Failed to get sign-in nonce');

    // 2. Ask wallet to sign
    const signature = await this.signer.signMessage(message);

    // 3. Verify with backend → get JWT
    const verifyResp = await fetch(API_BASE + '/api/auth/verify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ address: this.address, signature, referralCode }),
    });
    const data = await verifyResp.json();
    if (!verifyResp.ok) throw new Error(data.error || 'Sign-in failed');

    this.token  = data.token;
    this.player = data.player;
    this._saveSession();

    window.dispatchEvent(new CustomEvent('wallet:signedIn', {
      detail: { player: this.player, token: this.token }
    }));

    // Register push notification subscription if permission already granted
    if (Notification.permission === 'granted') {
      this.registerPush().catch(() => {});
    }

    return data;
  }

  // ─────────────────────────────────────────────────────────
  //  DISCONNECT
  // ─────────────────────────────────────────────────────────
  disconnect() {
    this.provider  = null;
    this.signer    = null;
    this.address   = null;
    this.chainId   = null;
    this.token     = null;
    this.player    = null;
    localStorage.removeItem('lfs_token');
    window.dispatchEvent(new CustomEvent('wallet:disconnected'));
  }

  // ─────────────────────────────────────────────────────────
  //  AUTHENTICATED FETCH
  // ─────────────────────────────────────────────────────────
  async authFetch(path, options = {}) {
    if (!this.token) throw new Error('Not signed in');
    const resp = await fetch(API_BASE + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.token,
        ...(options.headers || {}),
      },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  // ─────────────────────────────────────────────────────────
  //  PUSH NOTIFICATIONS
  // ─────────────────────────────────────────────────────────
  async requestPushPermission() {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') await this.registerPush();
    return perm;
  }

  async registerPush() {
    if (!('serviceWorker' in navigator)) return;
    const reg   = await navigator.serviceWorker.ready;
    const keyResp = await fetch(API_BASE + '/api/push/vapid-public-key');
    const { publicKey } = await keyResp.json();
    if (!publicKey) return;

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await this.authFetch('/api/push/subscribe', {
      method: 'POST',
      body:   JSON.stringify(sub.toJSON()),
    });
  }

  // ─────────────────────────────────────────────────────────
  //  CHAIN UTILITIES
  // ─────────────────────────────────────────────────────────
  async switchToMainnet() {
    await this._switchChain('0x1');
  }

  async addArbitrumOne() {
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId:         '0xa4b1',
        chainName:       'Arbitrum One',
        nativeCurrency:  { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls:         ['https://arb1.arbitrum.io/rpc'],
        blockExplorerUrls: ['https://arbiscan.io'],
      }],
    });
  }

  // ─────────────────────────────────────────────────────────
  //  GETTERS
  // ─────────────────────────────────────────────────────────
  get isConnected()  { return !!this.address; }
  get isSignedIn()   { return !!this.token; }
  get shortAddress() {
    if (!this.address) return '';
    return this.address.slice(0, 6) + '...' + this.address.slice(-4);
  }

  // ─────────────────────────────────────────────────────────
  //  PRIVATE: connectors
  // ─────────────────────────────────────────────────────────
  async _connectMetaMask() {
    if (!window.ethereum?.isMetaMask) {
      throw new Error('MetaMask not installed. Please install it from metamask.io');
    }
    // Dynamically import ethers (loaded via CDN on pages that need it)
    const { BrowserProvider } = window.ethers || await import('https://cdn.jsdelivr.net/npm/ethers@6/dist/ethers.min.js');
    this.provider = new BrowserProvider(window.ethereum);
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    this.address  = accounts[0];
    this.chainId  = (await this.provider.getNetwork()).chainId.toString();
    this.signer   = await this.provider.getSigner();
  }

  async _connectWalletConnect() {
    // WalletConnect v2 - requires @walletconnect/ethereum-provider loaded via CDN
    if (!window.EthereumProvider) {
      throw new Error('WalletConnect EthereumProvider not loaded. Add script tag: https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2/dist/index.umd.min.js');
    }
    const provider = await window.EthereumProvider.init({
      projectId:  window.WC_PROJECT_ID || '',   // set window.WC_PROJECT_ID before connecting
      chains:     [1],
      showQrModal: true,
    });
    await provider.connect();

    const { BrowserProvider } = window.ethers || await import('https://cdn.jsdelivr.net/npm/ethers@6/dist/ethers.min.js');
    this.provider = new BrowserProvider(provider);
    this.address  = provider.accounts[0];
    this.chainId  = provider.chainId.toString();
    this.signer   = await this.provider.getSigner();
  }

  async _connectCoinbase() {
    if (!window.CoinbaseWalletSDK) {
      throw new Error('Coinbase Wallet SDK not loaded.');
    }
    const sdk = new window.CoinbaseWalletSDK({ appName: 'Last Flag Standing' });
    const cbProvider = sdk.makeWeb3Provider();
    await cbProvider.request({ method: 'eth_requestAccounts' });

    const { BrowserProvider } = window.ethers || await import('https://cdn.jsdelivr.net/npm/ethers@6/dist/ethers.min.js');
    this.provider = new BrowserProvider(cbProvider);
    const network = await this.provider.getNetwork();
    this.address  = (await this.provider.listAccounts())[0]?.address;
    this.chainId  = network.chainId.toString();
    this.signer   = await this.provider.getSigner();
  }

  async _switchChain(hexChainId) {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    });
  }

  // ─────────────────────────────────────────────────────────
  //  PRIVATE: listeners
  // ─────────────────────────────────────────────────────────
  _setupListeners() {
    if (!window.ethereum) return;

    window.ethereum.on('accountsChanged', accounts => {
      if (accounts.length === 0) {
        this.disconnect();
      } else {
        this.address = accounts[0];
        window.dispatchEvent(new CustomEvent('wallet:accountChanged', {
          detail: { address: this.address }
        }));
      }
    });

    window.ethereum.on('chainChanged', chainId => {
      this.chainId = parseInt(chainId, 16).toString();
      window.dispatchEvent(new CustomEvent('wallet:chainChanged', {
        detail: { chain: this.chainId }
      }));
    });

    window.ethereum.on('disconnect', () => this.disconnect());
  }

  _saveSession() {
    if (this.token) localStorage.setItem('lfs_token', this.token);
  }

  async _restoreSession() {
    const token = localStorage.getItem('lfs_token');
    if (!token) return;
    this.token = token;
    try {
      const resp = await fetch(API_BASE + '/api/auth/me', {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (resp.ok) this.player = await resp.json();
      else this.token = null;
    } catch {
      this.token = null;
    }
  }
}

// ── Helper: VAPID key conversion ───────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// Export as ES module and also assign to window for non-module pages
if (typeof module !== 'undefined') module.exports = Wallet;
window.Wallet = Wallet;

// ─────────────────────────────────────────────────────────────
//  GLOBAL INSTANCE + UI BINDING
//  Automatically binds to elements with data-wallet-connect="*"
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const wallet = new Wallet();
  window._wallet = wallet;

  // UI: Connect buttons
  document.querySelectorAll('[data-wallet-connect]').forEach(btn => {
    const type = btn.dataset.walletConnect || 'metamask';
    btn.addEventListener('click', async () => {
      try {
        btn.disabled = true;
        btn.textContent = 'Connecting...';
        await wallet.connect(type);
        await wallet.signIn(new URLSearchParams(location.search).get('ref') || undefined);
      } catch (err) {
        alert('Connection failed: ' + err.message);
        btn.disabled = false;
        btn.textContent = btn.dataset.originalText || 'Connect';
      }
    });
    btn.dataset.originalText = btn.textContent;
  });

  // UI: Update wallet status elements
  window.addEventListener('wallet:signedIn', ({ detail }) => {
    document.querySelectorAll('[data-wallet-address]').forEach(el => {
      el.textContent = detail.player.username || wallet.shortAddress;
    });
    document.querySelectorAll('[data-wallet-signed-in]').forEach(el => {
      el.style.display = '';
    });
    document.querySelectorAll('[data-wallet-guest]').forEach(el => {
      el.style.display = 'none';
    });
  });

  window.addEventListener('wallet:disconnected', () => {
    document.querySelectorAll('[data-wallet-signed-in]').forEach(el => {
      el.style.display = 'none';
    });
    document.querySelectorAll('[data-wallet-guest]').forEach(el => {
      el.style.display = '';
    });
  });
});
