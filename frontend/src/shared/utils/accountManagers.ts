import {
  ACCOUNT_MANAGER_AVATARS,
  ACCOUNT_MANAGER_WHATSAPP_NUMBERS,
  FALLBACK_WHATSAPP_NUMBER,
} from "@/shared/constants/accountManagers";

export function getAccountManagerAvatar(name: string | null | undefined): string | undefined {
  const key = (name ?? "").trim();
  if (!key) return undefined;
  return ACCOUNT_MANAGER_AVATARS[key];
}

export function getAccountManagerWhatsAppNumber(name: string | null | undefined): string | null {
  const managerName = (name ?? "").trim();
  if (!managerName) return null;
  return ACCOUNT_MANAGER_WHATSAPP_NUMBERS[managerName] ?? null;
}

export function getFallbackAccountManagerWhatsAppNumber(name: string | null | undefined): string {
  const managerName = (name ?? "").trim();
  if (!managerName) return FALLBACK_WHATSAPP_NUMBER;
  return ACCOUNT_MANAGER_WHATSAPP_NUMBERS[managerName] ?? FALLBACK_WHATSAPP_NUMBER;
}
