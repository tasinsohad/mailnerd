import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// A reset password is shown once: it isn't stored anywhere readable.
export function TempPasswordDialog({ email, password, onClose }: { email: string; password: string; onClose: () => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast.success("Copied.");
    } catch {
      toast.error("Couldn't copy. Select the password and copy it by hand.");
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New temporary password</DialogTitle>
          <DialogDescription>
            For {email}. It's shown only this once. Send it to them privately; they can change it in Settings.
            They've been signed out everywhere.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted p-3">
          <code className="ident flex-1 select-all break-all text-base">{password}</code>
          <Button size="sm" variant="outline" onClick={copy}>
            <Copy className="h-4 w-4" /> Copy
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
