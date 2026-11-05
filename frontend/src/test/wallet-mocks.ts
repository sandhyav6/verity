// Shared, mutable stand-ins for the wallet layer so component tests can put the UI in any wallet state
// (disconnected, wrong network, pending, failed...) without a browser extension or a chain.
import { vi } from "vitest";
import type { ReactNode } from "react";

export const walletMock = {
  address: undefined as `0x${string}` | undefined,
  isConnected: false,
  wrongNetwork: false,
  hasInjectedWallet: true,
  connect: vi.fn(),
  disconnect: vi.fn(),
  switchNetwork: vi.fn(),
  connecting: false,
  switching: false,
  error: null as string | null,
};

export const authMock = {
  session: null as { address: string } | null,
  sessionLoading: false,
  signedIn: false,
  isIssuer: false,
  isManager: false,
  rolesAvailable: true,
  signIn: vi.fn(),
  signingIn: false,
  signInError: null as string | null,
  signOut: vi.fn(),
};

export const txMock = {
  state: { phase: "idle" } as { phase: string; hash?: string; error?: string; slow?: boolean },
  send: vi.fn(async (..._a: unknown[]) => null as string | null),
  reset: vi.fn(),
  busy: false,
};

export const clientMock = { readContract: vi.fn() };

export const USER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

export function resetMocks() {
  Object.assign(walletMock, { address: undefined, isConnected: false, wrongNetwork: false, hasInjectedWallet: true, connecting: false, switching: false, error: null });
  Object.assign(authMock, { session: null, sessionLoading: false, signedIn: false, isIssuer: false, isManager: false, rolesAvailable: true, signingIn: false, signInError: null });
  txMock.state = { phase: "idle" };
  txMock.busy = false;
  txMock.send.mockReset().mockResolvedValue(null);
  clientMock.readContract.mockReset();
  for (const f of [walletMock.connect, walletMock.disconnect, walletMock.switchNetwork, authMock.signIn, authMock.signOut, txMock.reset]) f.mockClear();
}

export function connectWallet(over: Partial<typeof walletMock> = {}) {
  Object.assign(walletMock, { address: USER, isConnected: true, ...over });
}

export function signInAs(roles: { issuer?: boolean; manager?: boolean } = {}) {
  connectWallet();
  Object.assign(authMock, { session: { address: USER.toLowerCase() }, signedIn: true, isIssuer: !!roles.issuer, isManager: !!roles.manager });
}

export const walletModule = { useWallet: () => walletMock };
export const authModule = { useAuth: () => authMock };
export const txModule = { useTx: () => txMock, waitForIndexed: vi.fn(async () => true) };
export const wagmiModule = {
  createConfig: vi.fn(),
  http: vi.fn(),
  WagmiProvider: ({ children }: { children: ReactNode }) => children,
  usePublicClient: () => clientMock,
  useConnection: () => ({ address: walletMock.address, isConnected: walletMock.isConnected, chainId: 31337 }),
  useWriteContract: () => ({ mutateAsync: vi.fn() }),
  useSignMessage: () => ({ mutateAsync: vi.fn() }),
  useConnectors: () => [],
  useConnect: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDisconnect: () => ({ mutate: vi.fn() }),
  useSwitchChain: () => ({ mutate: vi.fn(), isPending: false }),
};
