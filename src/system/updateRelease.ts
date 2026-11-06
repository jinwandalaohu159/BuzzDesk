// What the latest BuzzDesk release on GitHub is, and whether it is newer than
// this build. Pure web logic: downloading and installing go through the native
// bridge (desktopApi).

export const updateReleaseUrl = "https://github.com/jinwandalaohu159/BuzzDesk/releases/latest";
const updateReleaseApiUrl = "https://api.github.com/repos/jinwandalaohu159/BuzzDesk/releases/latest";
export const currentAppVersion = __APP_VERSION__;

interface GitHubReleaseResponse {
  tag_name?: string;
  html_url?: string;
  name?: string | null;
  assets?: GitHubReleaseAsset[];
}

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

export interface UpdateReleaseCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  installerUrl: string | null;
  installerName: string | null;
}

export async function checkForUpdateRelease(): Promise<UpdateReleaseCheckResult> {
  const response = await fetch(updateReleaseApiUrl, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub release check failed: ${response.status}`);
  }

  const release = (await response.json()) as GitHubReleaseResponse;
  const latestVersion = normalizeVersionTag(release.tag_name ?? release.name ?? "");
  if (!latestVersion) {
    throw new Error("GitHub latest release does not contain a version tag");
  }
  const installer = findReleaseInstaller(release.assets);

  return {
    currentVersion: currentAppVersion,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, currentAppVersion) > 0,
    releaseUrl: release.html_url ?? updateReleaseUrl,
    installerUrl: installer?.browser_download_url ?? null,
    installerName: installer?.name ?? null
  };
}

// "v1.2.3" for display; "未知" when there is no version.
export function formatVersion(version: string) {
  const normalized = version.trim();
  return normalized ? `v${normalized.replace(/^v/i, "")}` : "未知";
}

function findReleaseInstaller(assets: GitHubReleaseAsset[] | undefined) {
  if (!assets) {
    return null;
  }

  return (
    assets.find((asset) => isWindowsInstallerAsset(asset, /setup\.exe$/i)) ??
    assets.find((asset) => isWindowsInstallerAsset(asset, /\.exe$/i)) ??
    null
  );
}

function isWindowsInstallerAsset(asset: GitHubReleaseAsset, pattern: RegExp) {
  return Boolean(asset.name?.match(pattern) && asset.browser_download_url);
}

function normalizeVersionTag(value: string) {
  return value.trim().replace(/^v/i, "");
}

function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length, 3); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  if (a.prerelease && !b.prerelease) {
    return -1;
  }

  if (!a.prerelease && b.prerelease) {
    return 1;
  }

  return a.prerelease.localeCompare(b.prerelease);
}

function parseVersion(value: string) {
  const [core, prerelease = ""] = normalizeVersionTag(value).split("-", 2);
  return {
    numbers: core.split(".").map((part) => {
      const number = Number.parseInt(part, 10);
      return Number.isFinite(number) ? number : 0;
    }),
    prerelease
  };
}
