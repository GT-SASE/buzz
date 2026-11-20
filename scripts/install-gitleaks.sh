#!/usr/bin/env bash
#
# Installs the gitleaks release pinned in .gitleaks-version into .tools/gitleaks.
#
# The archive is checked against a SHA-256 pinned in this file, taken from the
# checksums file published with the release. Nothing is installed unless the
# hash matches. To upgrade, change .gitleaks-version and all four checksums
# together, using the new release's official checksums file.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root
readonly tools_dir="${repo_root}/.tools"

die() {
  echo "install-gitleaks: $*" >&2
  exit 1
}

GITLEAKS_VERSION="$(cat "${repo_root}/.gitleaks-version")" \
  || die "cannot read .gitleaks-version"
readonly GITLEAKS_VERSION
[[ "${GITLEAKS_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "invalid version in .gitleaks-version"

os="$(uname -s)"
arch="$(uname -m)"
case "${os}/${arch}" in
  Darwin/arm64)
    platform="darwin_arm64"
    expected_sha256="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"
    ;;
  Darwin/x86_64)
    platform="darwin_x64"
    expected_sha256="dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"
    ;;
  Linux/aarch64 | Linux/arm64)
    platform="linux_arm64"
    expected_sha256="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
    ;;
  Linux/x86_64)
    platform="linux_x64"
    expected_sha256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
    ;;
  *)
    die "unsupported platform: ${os}/${arch}"
    ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "need sha256sum or shasum to verify the download"
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

archive="gitleaks_${GITLEAKS_VERSION}_${platform}.tar.gz"
url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}"

echo "Downloading ${url}"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --retry 5 --retry-all-errors --retry-delay 2 --max-time 300 \
  --output "${work_dir}/${archive}" "${url}" \
  || die "download failed"

actual_sha256="$(sha256_of "${work_dir}/${archive}")"
if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
  die "checksum mismatch for ${archive}; nothing installed
  expected: ${expected_sha256}
  actual:   ${actual_sha256}"
fi
echo "SHA-256 verified: ${actual_sha256}"

tar -xzf "${work_dir}/${archive}" -C "${work_dir}" gitleaks \
  || die "could not extract gitleaks from ${archive}"
chmod 755 "${work_dir}/gitleaks"

installed_version="$("${work_dir}/gitleaks" version)" \
  || die "the downloaded binary did not run"
[[ "${installed_version}" == "${GITLEAKS_VERSION}" ]] \
  || die "expected version ${GITLEAKS_VERSION}, binary reports ${installed_version}"

mkdir -p "${tools_dir}"
mv -f "${work_dir}/gitleaks" "${tools_dir}/gitleaks"
echo "Installed gitleaks ${installed_version} to .tools/gitleaks"
