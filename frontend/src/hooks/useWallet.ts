import { useCallback } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { useAppConfig } from "../blockchain/config";

export interface WalletState {
  address: `0x${string}` | undefined;
  isConnected: boolean;
  /** connected, but the wallet is on a different network than this deployment */
  wrongNetwork: boolean;
  hasInjectedWallet: boolean;
  connect: () => void;
  disconnect: () => void;
  switchNetwork: () => void;
  connecting: boolean;
  switching: boolean;
  error: string | null;
}

/** Everything the UI needs to know about the wallet, in one place (and one thing to mock in tests). */
export function useWallet(): WalletState {
  const cfg = useAppConfig();
  const { address, chainId, isConnected } = useConnection();
  const connectors = useConnectors();
  const connectM = useConnect();
  const disconnectM = useDisconnect();
  const switchM = useSwitchChain();

  const connect = useCallback(() => {
    const connector = connectors[0];
    if (connector) connectM.mutate({ connector });
  }, [connectors, connectM]);

  return {
    address,
    isConnected,
    wrongNetwork: isConnected && chainId !== cfg.chain_id,
    hasInjectedWallet: typeof window !== "undefined" && "ethereum" in window,
    connect,
    disconnect: () => disconnectM.mutate(),
    switchNetwork: () => switchM.mutate({ chainId: cfg.chain_id }),
    connecting: connectM.isPending,
    switching: switchM.isPending,
    error: connectM.error ? connectM.error.message : null,
  };
}
