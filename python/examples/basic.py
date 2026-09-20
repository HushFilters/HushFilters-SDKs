"""Run after installing ./python; configure TLS via HUSHCLIENT_CA_FILE."""
import os

from hushclient import HushClient, credential_hash


def make_client() -> HushClient:
    return HushClient(
        os.getenv("HUSHCLIENT_BASE_URL", "https://localhost"),
        ca_file=os.getenv("HUSHCLIENT_CA_FILE"),
        verify_tls=os.getenv("HUSHCLIENT_INSECURE") != "1",
    )


def main() -> None:
    client = make_client()
    print("Health:", client.health())
    digest = credential_hash("testusername1@nwebbed.com", "testpassword1")
    print("Hash check:", client.check_hash(digest))
    print("Credential check:", client.check("testusername1@nwebbed.com", "testpassword1"))
    print("Credential batch:", client.check_batch([
        {"username": "testusername1@nwebbed.com", "password": "testpassword1"},
        {"username": "testusername2@nwebbed.com", "password": "testpassword2"},
    ]))
    print("Hash batch:", client.check_hash_batch([digest]))


if __name__ == "__main__":
    main()

