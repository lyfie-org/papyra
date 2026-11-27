import json
import os
import sys
from collections import Counter, defaultdict

ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]


def main() -> int:
    out_dir, label, target, gate_set, gate, trivy_version = sys.argv[1:7]
    gate_severities = {s.strip().upper() for s in gate_set.split(",") if s.strip()}
    enforce = gate.lower() == "true"

    with open(os.path.join(out_dir, "report.json"), encoding="utf-8") as fh:
        report = json.load(fh)

    total = Counter()
    fixable = Counter()
    groups = defaultdict(lambda: {"severity": "UNKNOWN", "ids": [], "fixed": ""})
    blocking = []

    for result in report.get("Results") or []:
        for vuln in result.get("Vulnerabilities") or []:
            severity = vuln.get("Severity", "UNKNOWN")
            fixed = vuln.get("FixedVersion", "") or ""
            total[severity] += 1
            if fixed:
                fixable[severity] += 1
            key = (result.get("Target", ""), vuln.get("PkgName", ""), vuln.get("InstalledVersion", ""))
            group = groups[key]
            group["fixed"] = fixed or group["fixed"]
            group["ids"].append(vuln.get("VulnerabilityID", ""))
            if ORDER.index(severity) < ORDER.index(group["severity"]):
                group["severity"] = severity
            if severity in gate_severities and fixed:
                blocking.append((severity, key[1], key[2], fixed, vuln.get("VulnerabilityID", ""), vuln.get("PrimaryURL", "")))

    lines = []
    lines.append(f"### Trivy: {label}")
    lines.append("")
    lines.append(f"`{target}` scanned with Trivy {trivy_version}. Vulnerabilities only; unfixed ones are listed but never block.")
    lines.append("")
    lines.append("| Severity | Found | Fix available |")
    lines.append("| --- | ---: | ---: |")
    for severity in ORDER:
        if total[severity] or severity in ("CRITICAL", "HIGH"):
            lines.append(f"| {severity.title()} | {total[severity]} | {fixable[severity]} |")
    lines.append("")

    gate_names = "/".join(s.title() for s in ORDER if s in gate_severities)
    if blocking:
        verdict = "blocks" if enforce else "would block a release"
        lines.append(f"**{len(blocking)} {gate_names} finding(s) with a fix available: this {verdict}.**")
        lines.append("")
        lines.append("| Severity | Package | Installed | Fixed in | Advisory |")
        lines.append("| --- | --- | --- | --- | --- |")
        for severity, pkg, installed, fixed, vid, url in sorted(blocking, key=lambda r: (ORDER.index(r[0]), r[1], r[4])):
            link = f"[{vid}]({url})" if url else vid
            lines.append(f"| {severity.title()} | `{pkg}` | `{installed}` | `{fixed}` | {link} |")
    else:
        passed = "this passes" if enforce else "a release would go through"
        lines.append(f"**No {gate_names} finding with a fix available: {passed}.**")
    lines.append("")

    if groups:
        lines.append("<details><summary>Every finding, grouped by package</summary>")
        lines.append("")
        lines.append("| Package | Installed | Fixed in | Worst | Advisories |")
        lines.append("| --- | --- | --- | --- | --- |")
        for (_, pkg, installed), group in sorted(groups.items(), key=lambda kv: (ORDER.index(kv[1]["severity"]), kv[0][1])):
            ids = ", ".join(sorted(set(group["ids"])))
            lines.append(f"| `{pkg}` | `{installed}` | `{group['fixed'] or 'no fix yet'}` | {group['severity'].title()} | {ids} |")
        lines.append("")
        lines.append("</details>")
        lines.append("")

    summary = "\n".join(lines) + "\n"
    with open(os.path.join(out_dir, "summary.md"), "w", encoding="utf-8") as fh:
        fh.write(summary)

    destination = os.environ.get("GITHUB_STEP_SUMMARY")
    if destination:
        with open(destination, "a", encoding="utf-8") as fh:
            fh.write(summary)
    else:
        print(summary)

    outputs = os.environ.get("GITHUB_OUTPUT")
    if outputs:
        with open(outputs, "a", encoding="utf-8") as fh:
            fh.write(f"blocking={len(blocking)}\n")
            for severity in ORDER[:4]:
                fh.write(f"{severity.lower()}={total[severity]}\n")

    if blocking and enforce:
        print(f"::error::{len(blocking)} {gate_names} finding(s) with a fix available. See the run summary.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
