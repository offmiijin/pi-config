import type { SandboxConfig } from "./types";

export const SANDBOX_BOOLEAN_SETTINGS = [
  { key: "enabled", label: "Sandbox", description: "Habilita o isolamento completo" },
  { key: "internet.enabled", label: "Internet", description: "Permite acesso à rede no perfil normal" },
  { key: "seccomp.enabled", label: "Seccomp", description: "Habilita o filtro de syscalls perigosas" },
  { key: "landlock.enabled", label: "Landlock", description: "Habilita a allowlist de filesystem" },
  { key: "profiles.normal.network", label: "Rede do perfil normal", description: "Compartilha a rede do host no perfil normal" },
  { key: "profiles.fetch.enabled", label: "Perfil fetch", description: "Habilita downloads na área isolada" },
  { key: "profiles.fetch.network", label: "Rede do perfil fetch", description: "Permite rede durante downloads isolados" },
  { key: "profiles.quarantine.enabled", label: "Perfil quarantine", description: "Habilita execução offline isolada" },
] as const;

export type SandboxBooleanSettingKey = (typeof SANDBOX_BOOLEAN_SETTINGS)[number]["key"];

export function getSandboxBooleanSetting(config: SandboxConfig, key: SandboxBooleanSettingKey): boolean {
  let current: unknown = config;
  for (const part of key.split(".")) {
    if (!current || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[part];
  }
  return current === true;
}

export function setSandboxBooleanSetting(
  config: SandboxConfig,
  key: SandboxBooleanSettingKey,
  value: boolean,
): void {
  const parts = key.split(".");
  let current = config as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
