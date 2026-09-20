"""Inspect sync state, or explicitly start a refresh with --apply."""
import argparse

from basic import make_client


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Download filters, update manifest, and reload")
    args = parser.parse_args()
    client = make_client()
    schedule = client.auto_update_status()
    print("Schedule:", {k: schedule.get(k) for k in ("enabled", "hour", "timezone", "next_update_at")})
    if args.apply:
        print("Accepted:", client.sync_apply())
        final = client.wait_for_sync(timeout=7200)
        print("Completed:", {k: final.get(k) for k in ("success", "filter_count", "detail")})
    else:
        status = client.sync_status()
        print("Latest sync:", {k: status.get(k) for k in ("active", "operation", "success")})


if __name__ == "__main__":
    main()

