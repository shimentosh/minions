import { formatDistanceToNowStrict } from "date-fns";

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Date.now() - d.getTime() < 45_000) return "just now";
  return `${formatDistanceToNowStrict(d)} ago`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function firstName(name: string | null | undefined) {
  return name?.trim().split(/\s+/)[0] ?? "";
}

export const ACTION_LABELS: Record<string, string> = {
  "item.viewed": "Viewed",
  "share.created": "Created a share link",
  "share.revoked": "Revoked a share link",
  "share.viewed": "Share link opened",
  "operator.viewed": "Opened the operator dashboard",
  "item.revealed": "Revealed a field",
  "item.created": "Created",
  "item.updated": "Updated",
  "item.deleted": "Moved to trash",
  "item.restored": "Restored",
  "item.purged": "Deleted permanently",
  "item.copied": "Copied",
  "item.autofilled": "Autofilled",
  "item.totp_generated": "Generated a 2FA code",
  "item.version_viewed": "Viewed history",
  "item.merged": "Merged",
  "note.created": "Note created",
  "note.updated": "Note edited",
  "note.deleted": "Note moved to trash",
  "vault.locked": "Vault locked",
  "vault.unlocked": "Vault unlocked",
  "vault.unlock_failed": "Unlock failed",
  "vault.exported": "Encrypted backup exported",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.login_failed": "Failed sign-in",
  "auth.registered": "Account created",
  "device.added": "Device added",
  "device.linked": "Extension connected",
  "device.revoked": "Device revoked",
  "session.revoked": "Session revoked",
  "session.revoked_all": "Sessions revoked",
  "import.completed": "Import completed",
  "item.shared": "Shared",
  "item.access_removed": "Removed access",
  "item.access_changed": "Changed access",
  "item.rekeyed": "Rotated the encryption key",
  "workspace.created": "Created the workspace",
  "workspace.renamed": "Renamed the workspace",
  "workspace.deleted": "Deleted the workspace",
  "workspace.rekeyed": "Rotated the workspace key",
  "workspace.member_invited": "Invited a member",
  "workspace.invitation_declined": "Declined the invitation",
  "workspace.member_joined": "Joined",
  "workspace.member_confirmed": "Confirmed a member",
  "workspace.member_removed": "Removed a member",
  "workspace.member_left": "Left the workspace",
  "workspace.role_changed": "Changed a role",
  "workspace.folder_created": "Created a folder",
  "workspace.folder_deleted": "Deleted a folder",
};

export const SECURITY_EVENT_LABELS: Record<string, string> = {
  new_device: "New device signed in",
  login_failed: "Failed sign-in",
  account_locked: "Account temporarily locked",
  master_password_changed: "Master password changed",
  two_factor_enabled: "Two-factor turned on",
  two_factor_disabled: "Two-factor turned off",
  recovery_code_used: "Recovery code used",
  recovery_codes_regenerated: "Recovery codes regenerated",
  session_revoked: "Session revoked",
  device_revoked: "Device revoked",
  emergency_lock: "Emergency lock",
  unlock_failed: "Wrong master password at unlock",
  settings_changed: "Security settings changed",
  vault_key_rotation_started: "Vault key change started",
  vault_key_rotated: "Vault key changed",
  email_verified: "Email address confirmed",
};
