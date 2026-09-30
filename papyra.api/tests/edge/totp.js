// Node twin of totp.py, used when no Python is on PATH. Same contract:
//   node totp.js secret <username>        -> the account's Base32 secret
//   node totp.js code <username> <step>   -> the six-digit code for that step
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0, value = 0; const out = [];
  for (const c of text.replace(/=+$/, '')) {
    value = (value << 5) | ALPHABET.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const secretFor = (name) =>
  base32Encode(crypto.createHash('sha1').update('papyra-test:' + name.trim().toLowerCase()).digest());

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1000000).padStart(6, '0');
}

const [cmd, name, step] = process.argv.slice(2);
if (cmd === 'ok') console.log('yes');
else if (cmd === 'secret' && name) console.log(secretFor(name));
else if (cmd === 'code' && name && step) console.log(codeAt(secretFor(name), Number(step)));
else { console.error('usage: totp.js secret <user> | code <user> <step>'); process.exit(2); }
