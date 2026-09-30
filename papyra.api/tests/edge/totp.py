"""TOTP twin of the test suite's TestAuth: codes for the harness accounts.

    totp.py secret <username>        -> the account's Base32 secret
    totp.py code <username> <step>   -> the six-digit code for that time step

Secrets are derived from the username (SHA-1 of "papyra-test:<name>"), the same
rule Papyra.Tests uses, so any run can produce any harness account's codes
without storing a secret anywhere.
"""
import base64
import hashlib
import hmac
import struct
import sys


def secret_for(username: str) -> str:
    digest = hashlib.sha1(("papyra-test:" + username.strip().lower()).encode()).digest()
    return base64.b32encode(digest).decode().rstrip("=")


def code_at(secret: str, step: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    mac = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    binary = struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{binary % 1_000_000:06d}"


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "ok":
        print("yes")
    elif len(sys.argv) == 3 and sys.argv[1] == "secret":
        print(secret_for(sys.argv[2]))
    elif len(sys.argv) == 4 and sys.argv[1] == "code":
        print(code_at(secret_for(sys.argv[2]), int(sys.argv[3])))
    else:
        sys.exit("usage: totp.py secret <user> | code <user> <step>")
