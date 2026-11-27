import json
import os
import sys
from collections import Counter, defaultdict

ORDER = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"]


def main() -> int:
    out_dir, label, target, version = sys.argv[1:5]

    with open(os.path.join(out_dir, "report.json"), encoding="utf-8") as fh:
        report = json.load(fh)

    total = Counter()
    fixable = Counter()
    groups = defaultdict(lambda: {"severity": "Unknown", "ids": set(), "fixed": ""})

    for match in report.get("matches") or []:
        vuln = match.get("vulnerability", {})
        artifact = match.get("artifact", {})
        severity = vuln.get("severity", "Unknown")
        if severity not in ORDER:
            severity = "Unknown"
        fix = vuln.get("fix", {}) or {}
        fixed = ", ".join(fix.get("versions") or []) if fix.get("state") == "fixed" else ""
        total[severity] += 1
        if fixed:
            fixable[severity] += 1
        key = (artifact.get("name", ""), artifact.get("version", ""))
        group = groups[key]
        group["fixed"] = fixed or group["fixed"]
        group["ids"].add(vuln.get("id", ""))
        if ORDER.index(severity) < ORDER.index(group["severity"]):
            group["severity"] = severity

    lines = [f"### Grype: {label}", ""]
    lines.append(f"`{target}` scanned with Grype {version}, as a second opinion beside Trivy. Report only; it never blocks.")
    lines.append("")
    lines.append("| Severity | Found | Fix available |")
    lines.append("| --- | ---: | ---: |")
    for severity in ORDER:
        if total[severity] or severity in ("Critical", "High"):
            lines.append(f"| {severity} | {total[severity]} | {fixable[severity]} |")
    lines.append("")

    if groups:
        lines.append("<details><summary>Every finding, grouped by package</summary>")
        lines.append("")
        lines.append("| Package | Installed | Fixed in | Worst | Advisories |")
        lines.append("| --- | --- | --- | --- | --- |")
        for (name, installed), group in sorted(groups.items(), key=lambda kv: (ORDER.index(kv[1]["severity"]), kv[0][0])):
            ids = ", ".join(sorted(group["ids"]))
            lines.append(f"| `{name}` | `{installed}` | `{group['fixed'] or 'no fix yet'}` | {group['severity']} | {ids} |")
        lines.append("")
        lines.append("</details>")
        lines.append("")
    else:
        lines.append("**No known vulnerabilities found.**")
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
            for severity in ORDER[:4]:
                fh.write(f"{severity.lower()}={total[severity]}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
