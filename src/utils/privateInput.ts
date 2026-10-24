// Read directly from the terminal without echoing input or exposing it in argv/env.
export async function privateInput(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('An interactive terminal is required');
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => { process.stdin.off('data', read); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const read = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') { cleanup(); reject(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0,-1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', read);
  });
}
