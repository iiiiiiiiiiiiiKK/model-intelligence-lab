"""
Downscales and re-compresses the README screenshots.

The capture script shoots at deviceScaleFactor 2 with fullPage, which produced
2-3 MB PNGs. That is wasteful for a README and made the initial git push time
out. Screenshots are re-encoded to a 1280px-wide PNG (8-bit palette where it does
not visibly hurt) so the repository stays light while the UI is still legible.

Usage:
  python scripts/optimize-screenshots.py [--width 1280] [--dry-run]
"""
import argparse
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs" / "screenshots"


def human(num_bytes: int) -> str:
    return f"{num_bytes / 1024:.0f} kB" if num_bytes < 1024 * 1024 else f"{num_bytes / 1024 / 1024:.2f} MB"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    files = sorted(SHOTS.glob("*.png"))
    if not files:
        print(f"No PNGs found in {SHOTS}", file=sys.stderr)
        return 1

    before_total = 0
    after_total = 0

    for path in files:
        before = path.stat().st_size
        before_total += before
        original_bytes = path.read_bytes()

        with Image.open(path) as img:
            original_size = img.size
            img = img.convert("RGB")
            if img.width > args.width:
                ratio = args.width / img.width
                img = img.resize((args.width, int(img.height * ratio)), Image.LANCZOS)
            out_size = img.size

            if args.dry_run:
                print(f"{path.name:26} {human(before):>8}  {original_size} -> {out_size}  (dry run)")
                after_total += before
                continue

            candidates = []

            # Palette PNG: excellent for a flat dark UI, occasionally worse on
            # gradient-heavy pages.
            palette_path = path.with_suffix(".pal.png")
            img.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).save(
                palette_path, format="PNG", optimize=True
            )
            candidates.append(palette_path)

            rgb_path = path.with_suffix(".rgb.png")
            img.save(rgb_path, format="PNG", optimize=True)
            candidates.append(rgb_path)

            # Keep whichever candidate is smallest — including the untouched
            # original, so this script can never inflate a file.
            best = min(candidates, key=lambda p: p.stat().st_size)
            best_size = best.stat().st_size
            if best_size < before:
                best.replace(path)
            for extra in candidates:
                if extra.exists():
                    extra.unlink()
            if best_size >= before:
                path.write_bytes(original_bytes)

        after = path.stat().st_size
        after_total += after
        print(f"{path.name:26} {human(before):>8} -> {human(after):>8}  {original_size} -> {out_size}")

    print()
    print(f"total {human(before_total)} -> {human(after_total)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
