import { Puzzle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  connectExtension,
  useExtensionAutoConnect,
  useExtensionBridge,
} from "@/lib/extension-bridge";
import { useSession } from "@/lib/session";

/**
 * Asks before connecting the browser extension for the first time (or to a
 * different account). Once linked, it unlocks with this app without asking.
 */
export function ExtensionConnectDialog() {
  useExtensionAutoConnect();
  const extension = useExtensionBridge((s) => s.extension);
  const linking = useExtensionBridge((s) => s.linking);
  const dismissedNonce = useExtensionBridge((s) => s.dismissedNonce);
  const me = useSession((s) => s.me);

  const open =
    !!extension &&
    !!me &&
    extension.wantsConnect &&
    extension.linkedUserId !== me.user.id &&
    dismissedNonce !== extension.nonce;
  const switching = !!extension?.linkedUserId && extension.linkedUserId !== me?.user.id;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && extension) useExtensionBridge.setState({ dismissedNonce: extension.nonce });
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-muted">
            <Puzzle className="size-5" />
          </div>
          <AlertDialogTitle>Connect the Minions extension?</AlertDialogTitle>
          <AlertDialogDescription>
            {extension?.device.name ?? "The extension"} will sign in as{" "}
            <span className="font-medium text-foreground">{me?.user.email}</span> and unlock
            whenever this app is unlocked in this browser. Your master password is not shared, and
            you can disconnect it any time under Devices.
            {switching
              ? " It is signed in to another account now; that one will be signed out."
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Not now</AlertDialogClose>
          <Button disabled={linking} onClick={() => void connectExtension()}>
            {linking ? <Spinner /> : null}
            Connect
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
