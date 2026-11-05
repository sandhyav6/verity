/**
 * DEV-ONLY wallet for local testing against a Hardhat node (which exposes unlocked accounts).
 * Enabled only when ALL hold: a development build (`vite dev`), the URL has `?devWallet=<n>`, and
 * the node is the local Hardhat chain id 31337. It is compiled out of production builds because
 * every use is behind `import.meta.env.DEV`. It holds NO keys: it forwards requests to the node.
 */
type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown>; on?: (e: string, f: (...a: unknown[]) => void) => void; removeListener?: (e: string, f: (...a: unknown[]) => void) => void; isMetaMask?: boolean };

export const DEV_WALLET_ACTIVE = { index: null as number | null };

export async function installDevWallet(rpcUrl: string): Promise<void> {
  if (!import.meta.env.DEV) return;
  const raw = new URLSearchParams(location.search).get("devWallet") ?? sessionStorage.getItem("devWallet");
  if (raw === null) return;
  const rpc = async (method: string, params: unknown[] = []) => {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
    return body.result;
  };
  if (parseInt(await rpc("eth_chainId"), 16) !== 31337) return; // never on a real network
  const accounts = (await rpc("eth_accounts")) as string[];
  const index = Number(raw);
  const account = accounts[index];
  if (!account) return;
  sessionStorage.setItem("devWallet", String(index));
  DEV_WALLET_ACTIVE.index = index;

  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const provider: Eip1193 = {
    isMetaMask: true,
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account];
        case "wallet_switchEthereumChain":
          return null;
        case "personal_sign": // [message, address]
          return rpc("personal_sign", [params[0], account]);
        case "eth_sendTransaction":
          return rpc(method, [{ ...(params[0] as object), from: account }]);
        default:
          return rpc(method, params);
      }
    },
    on: (e, f) => void (listeners.get(e) ?? listeners.set(e, new Set()).get(e)!).add(f),
    removeListener: (e, f) => void listeners.get(e)?.delete(f),
  };
  (window as unknown as { ethereum: Eip1193 }).ethereum = provider;
}
