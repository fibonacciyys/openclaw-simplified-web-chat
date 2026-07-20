#!/usr/bin/env python3
"""Migrate OpenClaw state between .openclaw home directories.

Copies agents/ and state/ from an old .openclaw directory into a new one,
then rewrites stale absolute sessionFile paths in sessions.json so transcript
files resolve under the new home instead of the old one.

Why this exists: when OPENCLAW_HOME changes, sessions.json keeps absolute
sessionFile paths pointing at the old home. The runtime resolver
(paths.ts:resolveStructuralSessionFallbackPath) returns those old absolute
paths verbatim, so new turns get appended to the old location while the UI
reloads from elsewhere and old messages appear to vanish. Converting
sessionFile to sessions-dir-relative paths makes the resolver rebind to the
new home.

Usage:
    python scripts/migrate_openclaw_state.py <OLD_OPENCLAW_DIR> <NEW_OPENCLAW_DIR>
           [--dry-run] [--no-backup] [--yes]
"""

import argparse
import datetime
import json
import os
import shutil
import sys

BACKUP_DIR_PREFIX = ".openclaw-backup-"


def log(msg):
    print(f"[migrate] {msg}")


def is_absolute_path(s):
    norm = s.replace("\\", "/")
    if norm.startswith("/"):
        return True
    if len(norm) > 1 and norm[1] == ":":
        return True
    if norm.startswith("//"):
        return True
    return False


def rebase_session_file(p):
    """Convert an absolute sessionFile path to a sessions-dir-relative path."""
    if not isinstance(p, str):
        return p
    s = p.strip()
    if not s or not is_absolute_path(s):
        return s
    norm = s.replace("\\", "/")
    marker = "/sessions/"
    idx = norm.rfind(marker)
    if idx >= 0:
        return norm[idx + len(marker) :]
    return norm.rsplit("/", 1)[-1]


def fix_session_files_in_obj(obj):
    """Recursively rewrite every sessionFile string field in a parsed JSON tree."""
    changed = 0
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            if k == "sessionFile" and isinstance(v, str) and v.strip():
                new_v = rebase_session_file(v)
                if new_v != v:
                    obj[k] = new_v
                    changed += 1
            else:
                changed += fix_session_files_in_obj(v)
    elif isinstance(obj, list):
        for item in obj:
            changed += fix_session_files_in_obj(item)
    return changed


def find_sessions_json_files(agents_dir):
    results = []
    for root, _dirs, files in os.walk(agents_dir):
        if "sessions.json" in files:
            results.append(os.path.join(root, "sessions.json"))
    return results


def backup_dir(src, backup_root, name):
    if not os.path.isdir(src):
        log(f"skip backup (missing): {src}")
        return None
    dest = os.path.join(backup_root, name)
    log(f"backup {src} -> {dest}")
    shutil.copytree(src, dest, dirs_exist_ok=True)
    return dest


def remove_dir(p):
    if os.path.exists(p):
        shutil.rmtree(p)


def copy_dir(src, dest, label):
    if not os.path.isdir(src):
        log(f"WARNING: source missing, skipping {label}: {src}")
        return False
    shutil.copytree(src, dest, dirs_exist_ok=True)
    log(f"copied {src} -> {dest}")
    return True


def fix_sessions_json(path, dry_run=False):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return 0
    except Exception as e:
        log(f"WARNING: could not parse {path}: {e}")
        return 0
    changed = fix_session_files_in_obj(data)
    if changed == 0:
        return 0
    if dry_run:
        log(f"[dry-run] would rewrite {changed} sessionFile path(s) in {path}")
    else:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
        log(f"rewrote {changed} sessionFile path(s) in {path}")
    return changed


def parent_dir(p):
    stripped = p.rstrip("/\\")
    parent = os.path.dirname(stripped)
    return parent if parent else "."


def main():
    parser = argparse.ArgumentParser(
        description="Migrate OpenClaw agents/ and state/ between .openclaw home dirs and fix stale sessionFile paths.",
    )
    parser.add_argument("old_openclaw", help="old .openclaw directory (source)")
    parser.add_argument("new_openclaw", help="new .openclaw directory (destination)")
    parser.add_argument(
        "--dry-run", action="store_true", help="preview without writing or deleting"
    )
    parser.add_argument(
        "--no-backup", action="store_true", help="skip backup of new dir (dangerous)"
    )
    parser.add_argument("--yes", action="store_true", help="skip confirmation prompt")
    args = parser.parse_args()

    old = os.path.abspath(args.old_openclaw)
    new = os.path.abspath(args.new_openclaw)

    if os.path.normpath(old) == os.path.normpath(new):
        sys.exit("error: old and new paths are identical")
    if not os.path.isdir(old):
        sys.exit(f"error: old .openclaw not found: {old}")
    if not os.path.isdir(os.path.join(old, "agents")) and not os.path.isdir(
        os.path.join(old, "state")
    ):
        sys.exit(f"error: neither agents/ nor state/ found in old .openclaw: {old}")

    print("=" * 64)
    print(f"  old (source): {old}")
    print(f"  new (target):  {new}")
    print(f"  dry-run:       {args.dry_run}")
    print(f"  backup:        {not args.no_backup}")
    print("=" * 64)
    log("WARNING: stop the OpenClaw gateway before continuing: openclaw gateway stop")
    log("         copying a live SQLite DB (state/openclaw.sqlite) can corrupt it.")

    if not args.yes and not args.dry_run:
        try:
            ans = input("\nProceed? [y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            sys.exit("aborted")
        if ans not in ("y", "yes"):
            sys.exit("aborted")

    os.makedirs(new, exist_ok=True)

    if not args.no_backup:
        ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_root = os.path.join(parent_dir(new), f"{BACKUP_DIR_PREFIX}{ts}")
        os.makedirs(backup_root, exist_ok=True)
        log(f"backup root: {backup_root}")
        backup_dir(os.path.join(new, "agents"), backup_root, "agents")
        backup_dir(os.path.join(new, "state"), backup_root, "state")

    total_fixed = 0
    if args.dry_run:
        log("[dry-run] skipping delete + copy")
        agents_src = os.path.join(old, "agents")
        if os.path.isdir(agents_src):
            for sj in find_sessions_json_files(agents_src):
                total_fixed += fix_sessions_json(sj, dry_run=True)
    else:
        log("removing new/agents and new/state")
        remove_dir(os.path.join(new, "agents"))
        remove_dir(os.path.join(new, "state"))

        copy_dir(os.path.join(old, "agents"), os.path.join(new, "agents"), "agents")
        copy_dir(os.path.join(old, "state"), os.path.join(new, "state"), "state")

        agents_dir = os.path.join(new, "agents")
        if os.path.isdir(agents_dir):
            sjs = find_sessions_json_files(agents_dir)
            log(f"found {len(sjs)} sessions.json file(s)")
            for sj in sjs:
                total_fixed += fix_sessions_json(sj, dry_run=False)
        else:
            log("WARNING: new/agents missing after copy; skipped sessionFile fix")

    print("=" * 64)
    print(f"  done. sessionFile paths fixed: {total_fixed}")
    if not args.dry_run:
        print("  next: openclaw doctor && openclaw gateway restart")
    print("=" * 64)


if __name__ == "__main__":
    main()
