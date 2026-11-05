import { useState } from "react";
import { addr, useAppConfig } from "../blockchain/config";
import { verityRegistryAbi } from "../blockchain/abi/verityRegistryAbi";
import { keys } from "../hooks/queries";
import { useTx } from "../hooks/useTx";
import { sha256Text } from "../lib/hash";
import { TxPanel } from "./TxPanel";
import { ConfirmDialog, useToast } from "./ui/feedback";
import { Field, Input } from "./ui/primitives";

const ZERO32 = "0x" + "00".repeat(32);

/** Revoke one registered document version. Permanent: the registration record is kept, marked revoked. */
export function RevokeDialog({ hash, title, version, onClose }: { hash: string | null; title: string; version: number; onClose: () => void }) {
  const cfg = useAppConfig();
  const tx = useTx();
  const toast = useToast();
  const [reason, setReason] = useState("");

  const close = () => { tx.reset(); setReason(""); onClose(); };

  async function confirm() {
    const done = await tx.send({
      address: addr(cfg.registry_address),
      abi: verityRegistryAbi as never,
      functionName: "revokeDocument",
      args: [hash, reason.trim() ? sha256Text(reason.trim()) : ZERO32],
      invalidate: [keys.documents, keys.stats, keys.audit],
    });
    if (done) {
      toast.push(`“${title}” was revoked on-chain.`, "ok");
      close();
    }
  }

  return (
    <ConfirmDialog open={!!hash} onClose={close} onConfirm={confirm} loading={tx.busy} danger confirmLabel={tx.state.phase === "failed" ? "Try again" : "Revoke permanently"}
      title={`Revoke version ${version}?`}
      description={`“${title}” will immediately stop verifying. The original registration stays on record, marked revoked. This cannot be undone, and other versions are not affected.`}>
      <div className="space-y-4">
        <Field label="Reason" optional hint="Only a hash of this text is recorded on-chain. Keep the text yourself if you need to prove it later.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} disabled={tx.busy} />
        </Field>
        <TxPanel state={tx.state} />
      </div>
    </ConfirmDialog>
  );
}
