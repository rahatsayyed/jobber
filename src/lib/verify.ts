import dns from 'node:dns';
import net from 'node:net';

function extractDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  return email.slice(at + 1).toLowerCase();
}

async function hasMx(domain: string): Promise<string | null> {
  try {
    const records = await dns.promises.resolveMx(domain);
    if (!records || records.length === 0) return null;
    records.sort((a, b) => a.priority - b.priority);
    return records[0].exchange;
  } catch {
    return null;
  }
}

function smtpProbe(host: string, email: string, from: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const socket = net.createConnection({ host, port: 25 });
    socket.setTimeout(5000);

    let step = 0;
    let buffer = '';

    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\r\n') && !buffer.endsWith('\n')) return;
      const code = buffer.slice(0, 3);
      buffer = '';

      if (step === 0) {
        // greeting
        if (!code.startsWith('2')) return finish(false);
        socket.write(`HELO verifier.local\r\n`);
        step = 1;
      } else if (step === 1) {
        if (!code.startsWith('2')) return finish(false);
        socket.write(`MAIL FROM:<${from}>\r\n`);
        step = 2;
      } else if (step === 2) {
        if (!code.startsWith('2')) return finish(false);
        socket.write(`RCPT TO:<${email}>\r\n`);
        step = 3;
      } else if (step === 3) {
        finish(code.startsWith('2'));
      }
    });
  });
}

export async function verifyEmail(
  email: string,
  opts: { trusted?: boolean } = {}
): Promise<boolean> {
  try {
    const domain = extractDomain(email);
    if (!domain) return false;

    const mxHost = await hasMx(domain);
    if (!mxHost) return false;

    if (opts.trusted) return true;

    return await smtpProbe(mxHost, email, `verify@${domain}`);
  } catch {
    return false;
  }
}
