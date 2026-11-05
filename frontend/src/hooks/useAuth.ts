import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import { api } from "../lib/api";
import { humanizeError } from "../lib/errors";
import { buildSiweMessage } from "../lib/siwe";
import type { NonceInfo, SessionInfo } from "../lib/types";
import { useWallet } from "./useWallet";

/** Sign-In with Ethereum: a nonce from the backend, a wallet signature, a server-side session. */
export function useAuth() {
  const wallet = useWallet();
  const qc = useQueryClient();
  const sign = useSignMessage();

  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<SessionInfo | null>("/auth/session"),
    staleTime: 30_000,
  });

  const signIn = useMutation({
    mutationFn: async () => {
      if (!wallet.address) throw new Error("Connect a wallet first.");
      const nonce = await api.get<NonceInfo>("/auth/nonce");
      const message = buildSiweMessage({
        domain: nonce.domain, address: wallet.address, statement: nonce.statement, uri: nonce.uri,
        chainId: nonce.chain_id, nonce: nonce.nonce, issuedAt: new Date(),
      });
      const signature = await sign.mutateAsync({ message });
      return api.post<SessionInfo>("/auth/verify", { message, signature });
    },
    onSuccess: (s) => {
      qc.setQueryData(["session"], s);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "session" });
    },
  });

  const signOut = useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSuccess: () => {
      qc.setQueryData(["session"], null);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "session" });
    },
  });

  const s = session.data ?? null;
  // The session belongs to a wallet. If the user switches accounts in their wallet, the old session no longer counts.
  const signedIn = !!s && !!wallet.address && s.address.toLowerCase() === wallet.address.toLowerCase();
  return {
    session: s,
    sessionLoading: session.isLoading,
    signedIn,
    isIssuer: signedIn && !!s?.is_issuer,
    isManager: signedIn && !!s?.is_manager,
    rolesAvailable: !s || s.roles_available,
    signIn: signIn.mutate,
    signingIn: signIn.isPending,
    signInError: signIn.error ? humanizeError(signIn.error) : null,
    signOut: signOut.mutate,
  };
}
