#!/usr/bin/env bash
set -euo pipefail

sbom=${1:?usage: scan-sbom.sh <spdx-json> <evidence-directory>}
evidence_dir=${2:?usage: scan-sbom.sh <spdx-json> <evidence-directory>}

if [ ! -s "$sbom" ]; then
  echo "SBOM is missing or empty: $sbom" >&2
  exit 1
fi
mkdir -p "$evidence_dir"

# Keep the scanner binary itself supply-chain verified. The vulnerability
# database remains current at scan time; Grype records its database metadata
# inside the unfiltered JSON evidence packet.
grype_version=0.116.0
grype_archive="grype_${grype_version}_linux_amd64.tar.gz"
grype_sha256=40aff724297312f91ea390d003bed8d8651c74cc7f5b26732db80b3a408d2fc5
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

curl -fsSL \
  "https://github.com/anchore/grype/releases/download/v${grype_version}/${grype_archive}" \
  -o "$work_dir/$grype_archive"
printf '%s  %s\n' "$grype_sha256" "$work_dir/$grype_archive" | sha256sum -c -
tar -xzf "$work_dir/$grype_archive" -C "$work_dir" grype
"$work_dir/grype" version > "$evidence_dir/grype-version.txt"

# Always retain the complete finding set. Every CRITICAL finding blocks even
# when no fix is published; fixable HIGH findings block as well. A future
# exception mechanism must be an explicit owner/expiry/rationale waiver, never
# an implicit consequence of a vendor having no patch yet.
"$work_dir/grype" "sbom:$sbom" -o json > "$evidence_dir/grype-findings.json"
jq '[.matches[] | select(.vulnerability.severity == "Critical")]' \
  "$evidence_dir/grype-findings.json" \
  > "$evidence_dir/grype-critical-findings.json"
if ! jq -e 'length == 0' "$evidence_dir/grype-critical-findings.json" >/dev/null; then
  echo "Unwaived CRITICAL vulnerabilities block this Compute image." >&2
  exit 1
fi
"$work_dir/grype" "sbom:$sbom" --only-fixed --fail-on high \
  | tee "$evidence_dir/grype-fixable-high-gate.txt"
