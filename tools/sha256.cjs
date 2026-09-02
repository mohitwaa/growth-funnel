// Pure-JS SHA-256 — n8n's Code sandbox disallows require('crypto').
function sha256(str) {
  const K = [];
  const H = [];
  let n = 2, c = 0;
  const isPrime = (x) => { for (let i = 2; i * i <= x; i++) if (x % i === 0) return false; return true; };
  while (c < 64) { if (isPrime(n)) { if (c < 8) H[c] = (Math.pow(n, 1/2) % 1 * 4294967296) | 0; K[c] = (Math.pow(n, 1/3) % 1 * 4294967296) | 0; c++; } n++; }
  const utf8 = unescape(encodeURIComponent(str));
  const bytes = []; for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
  const bitLen = bytes.length * 8;
  bytes.push(0x80); while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);
  const rotr = (x, k) => (x >>> k) | (x << (32 - k));
  let h = H.slice(0, 8);
  for (let b = 0; b < bytes.length; b += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) w[i] = (bytes[b+i*4]<<24)|(bytes[b+i*4+1]<<16)|(bytes[b+i*4+2]<<8)|bytes[b+i*4+3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15]>>>3);
      const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2]>>>10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let [a,bb,cc,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const mj = (a & bb) ^ (a & cc) ^ (bb & cc);
      const t2 = (S0 + mj) | 0;
      hh=g; g=f; f=e; e=(d+t1)|0; d=cc; cc=bb; bb=a; a=(t1+t2)|0;
    }
    h = [ (h[0]+a)|0,(h[1]+bb)|0,(h[2]+cc)|0,(h[3]+d)|0,(h[4]+e)|0,(h[5]+f)|0,(h[6]+g)|0,(h[7]+hh)|0 ];
  }
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
module.exports = { sha256 };
