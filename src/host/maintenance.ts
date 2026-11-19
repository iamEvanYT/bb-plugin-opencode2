import {
  experimental_compareVersions as compareVersions,
  experimental_installationVerification as installationVerification,
  experimental_npmGlobalInstallCommand as npmGlobalInstallCommand,
  experimental_npmGlobalInstallSource as npmGlobalInstallSource,
  experimental_npmLatestVersion as npmLatestVersion,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_readCliVersion as readCliVersion,
  experimental_resolveExecutablePath as resolveExecutablePath,
  type ProviderHealth,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ModelSettings } from "../settings-contract.ts";
import { openCodeServer } from "./opencode-server.ts";
import { errorMessage } from "./types.ts";

export const OPENCODE_EXECUTABLE = "opencode2";
export const OPENCODE_NPM_PACKAGE = "@opencode/cli";
/** The oldest OpenCode whose API this bridge was verified against. */
export const MIN_OPENCODE_VERSION = "2.3.1";
export const OPENCODE_LOGIN_COMMAND = "opencode2 auth login";

const LATEST_VERSION_TTL_MS = 60 * 60 * 1000;
let latestVersionCache: { at: number; value: string | null } | undefined;

async function latestVersion(checkUpdates: boolean) {
  if (
    latestVersionCache &&
    (!checkUpdates ||
      Date.now() - latestVersionCache.at < LATEST_VERSION_TTL_MS)
  )
    return latestVersionCache.value;
  if (!checkUpdates) return null;
  const value = await npmLatestVersion(OPENCODE_NPM_PACKAGE).catch(() => null);
  latestVersionCache = { at: Date.now(), value };
  return value;
}

export function isSupportedVersion(version: string) {
  return compareVersions(version, MIN_OPENCODE_VERSION) >= 0;
}

export async function installationStatus(
  checkUpdates = true,
): Promise<ProviderInstallationStatus> {
  const [executablePath, currentVersion, latest, probe] = await Promise.all([
    resolveExecutablePath(OPENCODE_EXECUTABLE).catch(() => null),
    readCliVersion(OPENCODE_EXECUTABLE),
    latestVersion(checkUpdates),
    probeNpmGlobalPackage(OPENCODE_NPM_PACKAGE).catch(() => ({
      npmBin: null,
      npmGlobalPackageVersion: null,
    })),
  ]);
  const installed = currentVersion !== null;
  const versionUnsupported =
    currentVersion !== null && !isSupportedVersion(currentVersion);
  const needsUpdate =
    currentVersion !== null &&
    latest !== null &&
    compareVersions(latest, currentVersion) > 0;
  return {
    currentVersion,
    executableName: OPENCODE_EXECUTABLE,
    executablePath,
    installAction: !installed
      ? {
          kind: "install",
          label: "Install",
          command: npmGlobalInstallCommand(OPENCODE_NPM_PACKAGE).displayCommand,
        }
      : needsUpdate || versionUnsupported
        ? {
            kind: "update",
            label: "Update",
            command: `${OPENCODE_EXECUTABLE} upgrade`,
          }
        : null,
    installSource: npmGlobalInstallSource({
      installed,
      executablePath,
      npmBin: probe.npmBin,
    }),
    installed,
    latestVersion: latest,
    minimumSupportedVersion: MIN_OPENCODE_VERSION,
    needsUpdate,
    npmGlobalPackageVersion: probe.npmGlobalPackageVersion,
    npmPackageName: OPENCODE_NPM_PACKAGE,
    versionUnsupported,
  };
}

/**
 * Install through npm; update through `opencode2 upgrade`, which knows how
 * OpenCode was installed (npm, bun, brew, or the curl installer).
 */
export async function installationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const status = await installationStatus();
  if (action === "install") {
    return {
      available: true,
      command: npmGlobalInstallCommand(OPENCODE_NPM_PACKAGE),
      verification: installationVerification(status, "install"),
    };
  }
  if (!status.installed) {
    return {
      available: false,
      message: "OpenCode v2 is not installed. Install it first.",
    };
  }
  return {
    available: true,
    command: {
      command: status.executablePath ?? OPENCODE_EXECUTABLE,
      args: ["upgrade"],
      displayCommand: `${OPENCODE_EXECUTABLE} upgrade`,
    },
    verification: installationVerification(status, "update"),
  };
}

export async function providerHealth(
  settings: ModelSettings,
  cwd: string,
): Promise<ProviderHealth> {
  const base = {
    accountEmail: null,
    planLabel: null,
    minimumSupportedVersion: MIN_OPENCODE_VERSION,
    canInstall: true,
    canUpdate: false,
    loginCommand: OPENCODE_LOGIN_COMMAND,
  };
  const installedVersion = await readCliVersion(OPENCODE_EXECUTABLE);
  // A disabled provider reports not_installed so BB hides it everywhere.
  if (!settings.providerEnabled || installedVersion === null)
    return {
      ...base,
      status: "not_installed",
      statusMessage: settings.providerEnabled
        ? null
        : "OpenCode v2 is disabled in the plugin settings.",
      installedVersion: null,
    };
  const latest = await latestVersion(false);
  const canUpdate =
    latest !== null && compareVersions(latest, installedVersion) > 0;
  if (!isSupportedVersion(installedVersion))
    return {
      ...base,
      status: "unsupported_version",
      statusMessage: `OpenCode ${installedVersion} is older than ${MIN_OPENCODE_VERSION}. Run \`${OPENCODE_EXECUTABLE} upgrade\`.`,
      installedVersion,
      canInstall: false,
      canUpdate: true,
    };
  try {
    const catalog = await openCodeServer.modelCatalog(cwd);
    if (catalog.models.length === 0)
      return {
        ...base,
        status: "unauthenticated",
        statusMessage: `OpenCode has no usable models. Run \`${OPENCODE_LOGIN_COMMAND}\` to connect a model provider.`,
        installedVersion,
        canInstall: false,
        canUpdate,
      };
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      statusMessage: `Could not reach the OpenCode service: ${errorMessage(error)}`,
      installedVersion,
      canInstall: false,
      canUpdate,
    };
  }
  return {
    ...base,
    status: "ready",
    statusMessage: null,
    installedVersion,
    canInstall: false,
    canUpdate,
  };
}
