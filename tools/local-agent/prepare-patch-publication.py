#!/usr/bin/env python3
"""Create and guide a verified multipart patch-publication payload."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).resolve().parent
if str(SCRIPT_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIRECTORY))

from patch_publication_prepare import prepare
from patch_publication_support import (
    DEFAULT_PART_SIZE_KIB,
    DEFAULT_TARGET_PART_TOKENS,
    PreparationError,
    git_blob_sha,
    split_utf8_patch,
)
from patch_publication_upload import (
    record_branch_sha,
    record_commit_sha,
    record_tree_sha,
    record_upload_sha,
    reset_upload_index,
    show_next_upload,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path("."))
    parser.add_argument("--repository-full-name")
    parser.add_argument("--target-branch")
    parser.add_argument("--transfer-branch")
    parser.add_argument("--default-branch", default="main")
    parser.add_argument("--tested-commit", default="HEAD")
    parser.add_argument("--expected-base-sha")
    parser.add_argument(
        "--part-size-kib",
        type=int,
        default=DEFAULT_PART_SIZE_KIB,
        help="hard per-part byte ceiling and fallback without a tokenizer",
    )
    parser.add_argument(
        "--target-part-tokens",
        type=int,
        default=DEFAULT_TARGET_PART_TOKENS,
        help="target o200k_base tokens for the JSON connector content string",
    )
    parser.add_argument(
        "--tokenizer",
        type=Path,
        help=(
            "local o200k_base.tiktoken path; may also be set with "
            "TEASESCRIPT_O200K_TOKENIZER"
        ),
    )
    parser.add_argument("--output-directory", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--show-next-upload",
        action="store_true",
        help="show the exact next blob, tree, commit, branch, or publication action",
    )
    mode.add_argument(
        "--record-upload-sha",
        help="record and verify the returned SHA for the pending blob upload",
    )
    mode.add_argument(
        "--record-tree-sha",
        help="record and verify the returned payload-only transfer-tree SHA",
    )
    mode.add_argument(
        "--record-commit-sha",
        help="record the returned transfer-commit SHA",
    )
    mode.add_argument(
        "--record-branch-sha",
        help="record and verify the resolved transfer-branch target SHA",
    )
    mode.add_argument(
        "--reset-upload-index",
        type=int,
        help="reset one blob upload and clear dependent later-stage state",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.show_next_upload:
            show_next_upload(args.output_directory)
        elif args.record_upload_sha is not None:
            record_upload_sha(args.output_directory, args.record_upload_sha)
        elif args.record_tree_sha is not None:
            record_tree_sha(args.output_directory, args.record_tree_sha)
        elif args.record_commit_sha is not None:
            record_commit_sha(args.output_directory, args.record_commit_sha)
        elif args.record_branch_sha is not None:
            record_branch_sha(args.output_directory, args.record_branch_sha)
        elif args.reset_upload_index is not None:
            reset_upload_index(args.output_directory, args.reset_upload_index)
        else:
            prepare(args)
    except (OSError, PreparationError) as exc:
        print(f"prepare-patch-publication: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
