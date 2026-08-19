// Node twin of json_get.py, used when no Python is on PATH.
// Same contract: a dotted path on argv, JSON on stdin, one value on stdout,
// an empty line for anything that does not resolve.

const path = process.argv[2] || '';
let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    process.stdout.write('\n');
    return;
  }

  for (const part of path.split('.')) {
    if (part === '') continue;
    if (doc === null || doc === undefined) break;
    if (/^\d+$/.test(part) && Array.isArray(doc)) {
      doc = doc[Number(part)];
    } else if (typeof doc === 'object') {
      if (part in doc) {
        doc = doc[part];
      } else {
        // Match the Python twin: fall back to a case-insensitive lookup so a
        // check does not have to know which casing an endpoint used.
        const key = Object.keys(doc).find((k) => k.toLowerCase() === part.toLowerCase());
        doc = key === undefined ? undefined : doc[key];
      }
    } else {
      doc = undefined;
    }
  }

  if (doc === null || doc === undefined) process.stdout.write('\n');
  else if (typeof doc === 'object') process.stdout.write(JSON.stringify(doc) + '\n');
  else process.stdout.write(String(doc) + '\n');
});
