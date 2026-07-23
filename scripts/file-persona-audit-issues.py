#!/usr/bin/env python3
"""
File every persona-audit finding as a GitHub issue.

Reads the three audit reports (PERSONA_AUDIT_ROUND1.md / ROUND2.md / ROUND3.md),
splits them into individual findings, and creates one GitHub issue per finding.

Idempotent: before creating, it lists open issues and skips any whose title
already exists, so it is safe to re-run.

Usage:
    GITHUB_TOKEN=ghp_xxx python3 scripts/file-persona-audit-issues.py [--dry-run]

The token needs `repo` scope (or `public_repo` for a public repo) with issue-write.
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

OWNER = "AwsomeFox"
REPO = "campfire"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"

# Reports live at the repo root, one dir up from this script.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORTS = [
    ("PERSONA_AUDIT_ROUND1.md", re.compile(r"^### (\d+)\.\s+(.*)$")),
    ("PERSONA_AUDIT_ROUND2.md", re.compile(r"^### (R2-\d+)\.\s+(.*)$")),
    ("PERSONA_AUDIT_ROUND3.md", re.compile(r"^### (R3-\d+)\.\s+(.*)$")),
]

# Per-finding labels. Key = finding id as it appears in the heading.
# Every issue also gets: persona-audit, theme: ai (added automatically below).
LABELS = {
    # Round 1
    "1": ["bug"], "2": ["enhancement", "theme: table-depth"],
    "3": ["enhancement", "theme: table-depth"], "4": ["enhancement", "theme: table-depth"],
    "5": ["bug"], "6": ["enhancement"], "7": ["enhancement"], "8": ["enhancement"],
    "9": ["bug"], "10": ["enhancement", "theme: table-depth"], "11": ["enhancement"],
    "12": ["enhancement"], "13": ["enhancement"], "14": ["enhancement"], "15": ["enhancement"],
    "16": ["enhancement", "theme: table-depth"], "17": ["bug", "security"], "18": ["bug"],
    "19": ["enhancement"], "20": ["bug"], "21": ["bug"], "22": ["bug"], "23": ["enhancement"],
    "24": ["bug"],
    # Round 2
    "R2-1": ["bug"], "R2-2": ["bug"], "R2-3": ["bug", "security"], "R2-4": ["enhancement"],
    "R2-5": ["bug"], "R2-6": ["enhancement", "theme: table-depth"],
    "R2-7": ["enhancement", "theme: table-depth"], "R2-8": ["enhancement", "theme: table-depth"],
    "R2-9": ["enhancement"], "R2-10": ["bug"], "R2-11": ["enhancement"],
    "R2-12": ["enhancement", "theme: table-depth"],
    # Round 3
    "R3-1": ["bug"], "R3-2": ["enhancement", "theme: table-depth"], "R3-3": ["bug"],
    "R3-4": ["bug", "accessibility"], "R3-5": ["bug"], "R3-6": ["enhancement"],
}

COMMON_LABELS = ["persona-audit", "theme: ai"]

TITLE_PREFIX = "[persona-audit] "


def parse_findings(path, heading_re):
    """Yield (id, title, body) for each `### <id>. Title` section in a report."""
    with open(path, encoding="utf-8") as fh:
        lines = fh.readlines()
    findings = []
    cur = None
    buf = []
    for line in lines:
        m = heading_re.match(line.rstrip("\n"))
        if m:
            if cur:
                findings.append((cur[0], cur[1], "".join(buf).strip()))
            cur = (m.group(1), m.group(2).strip())
            buf = []
        elif cur is not None:
            # Stop a finding at the next top-level section (## ...) that is not a finding.
            if line.startswith("## ") and not line.startswith("### "):
                findings.append((cur[0], cur[1], "".join(buf).strip()))
                cur = None
                buf = []
            else:
                buf.append(line)
    if cur:
        findings.append((cur[0], cur[1], "".join(buf).strip()))
    return findings


def gh_request(method, url, token, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "campfire-persona-audit")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


def existing_open_titles(token):
    titles = set()
    page = 1
    while True:
        url = f"{API}/issues?state=open&per_page=100&page={page}"
        batch = gh_request("GET", url, token)
        if not batch:
            break
        for it in batch:
            # Skip PRs (they also appear in the issues endpoint).
            if "pull_request" in it:
                continue
            titles.add(it["title"])
        if len(batch) < 100:
            break
        page += 1
    return titles


def main():
    dry_run = "--dry-run" in sys.argv
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token and not dry_run:
        print("ERROR: set GITHUB_TOKEN (repo scope, issue-write) or pass --dry-run", file=sys.stderr)
        sys.exit(1)

    all_findings = []
    for fname, heading_re in REPORTS:
        path = os.path.join(ROOT, fname)
        if not os.path.exists(path):
            print(f"WARN: {fname} not found, skipping", file=sys.stderr)
            continue
        rnd = fname.replace("PERSONA_AUDIT_", "").replace(".md", "")
        for fid, title, body in parse_findings(path, heading_re):
            all_findings.append((rnd, fid, title, body))

    print(f"Parsed {len(all_findings)} findings from {len(REPORTS)} reports.")

    existing = set()
    if not dry_run:
        existing = existing_open_titles(token)
        print(f"Found {len(existing)} existing open issues (for dedup).")

    created, skipped = 0, 0
    for rnd, fid, title, body in all_findings:
        issue_title = f"{TITLE_PREFIX}{title}"
        labels = COMMON_LABELS + LABELS.get(fid, ["enhancement"])
        footer = (
            f"\n\n---\n_Filed by the persona audit ({rnd}, finding {fid}). "
            f"Audited commit `fa52628`. See `PERSONA_AUDIT_{rnd}.md`._"
        )
        full_body = body + footer

        if issue_title in existing:
            print(f"SKIP (exists): {issue_title}")
            skipped += 1
            continue

        if dry_run:
            print(f"[dry-run] would create: {issue_title}  labels={labels}")
            created += 1
            continue

        try:
            issue = gh_request(
                "POST", f"{API}/issues", token,
                {"title": issue_title, "body": full_body, "labels": labels},
            )
            print(f"CREATED #{issue['number']}: {issue_title}")
            created += 1
            time.sleep(1.5)  # be gentle with the secondary rate limit
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            print(f"FAILED: {issue_title}\n  {e.code} {detail}", file=sys.stderr)
            # A 422 for an unknown label shouldn't abort the whole run.
            if e.code == 422 and "label" in detail.lower():
                try:
                    issue = gh_request(
                        "POST", f"{API}/issues", token,
                        {"title": issue_title, "body": full_body, "labels": COMMON_LABELS},
                    )
                    print(f"  retried with base labels -> CREATED #{issue['number']}")
                    created += 1
                    time.sleep(1.5)
                    continue
                except Exception as e2:
                    print(f"  retry also failed: {e2}", file=sys.stderr)
            if e.code in (401, 403):
                print("  auth/permission error — aborting.", file=sys.stderr)
                sys.exit(1)

    print(f"\nDone. created/would-create={created}, skipped(existing)={skipped}")


if __name__ == "__main__":
    main()
