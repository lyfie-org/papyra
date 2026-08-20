"""Read one value out of a JSON document on stdin.

Usage:  json_get.py <dotted-path>

The path is dotted, with numeric segments meaning "index into a list":

    id            -> doc["id"]
    0.id          -> doc[0]["id"]
    user.name     -> doc["user"]["name"]
    ""            -> the whole document

Anything that cannot be resolved prints an empty line and exits 0, so a
harness check reads a missing field as "" rather than as a crash. Booleans
print as `true`/`false` (not Python's `True`/`False`) so a shell comparison
against the JSON the API actually sent works.
"""

import json
import sys


def resolve(doc, path):
    for part in path.split("."):
        if part == "":
            continue
        if part.isdigit() and isinstance(doc, list):
            index = int(part)
            if index >= len(doc):
                return None
            doc = doc[index]
        elif isinstance(doc, dict):
            # The API serialises camelCase, but a caller writing a check should
            # not have to remember which casing a given endpoint used.
            if part in doc:
                doc = doc[part]
            else:
                lowered = {k.lower(): v for k, v in doc.items()}
                doc = lowered.get(part.lower())
        else:
            return None
        if doc is None:
            return None
    return doc


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        doc = json.load(sys.stdin)
    except (ValueError, UnicodeDecodeError):
        print("")
        return
    value = resolve(doc, path)
    if value is None:
        print("")
    elif isinstance(value, bool):
        print("true" if value else "false")
    elif isinstance(value, (dict, list)):
        print(json.dumps(value))
    else:
        print(value)


if __name__ == "__main__":
    main()
