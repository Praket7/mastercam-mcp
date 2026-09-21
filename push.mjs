import * as fs from 'fs';
import * as path from 'path';
import http from 'isomorphic-git/http/node';
import git from 'isomorphic-git';

const dir = '/tmp/mcp-push';
const url = 'https://github.com/Praket7/mastercam-mcp.git';
import { execSync } from 'child_process';
const token = execSync('gh auth token', {encoding:'utf8'}).trim();
const auth = { username: token, password: 'x-oauth-basic' };

console.log('Cleaning', dir);
fs.rmSync(dir, {recursive:true, force:true});
fs.mkdirSync(dir, {recursive:true});

console.log('Cloning audit-remediation...');
await git.clone({
  fs, http,
  dir,
  url,
  ref: 'audit-remediation',
  singleBranch: true,
  depth: 1,
  onAuth: () => auth,
});
console.log('Cloned');

console.log('Copying files...');
execSync(`rsync -av --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='.tmp' --exclude='coverage' --exclude='mastercam-mcp' --exclude='mastercam-mcp-main' --exclude='work' /Users/pcg/mastercam-mcp/ ${dir}/`, {stdio:'inherit'});

console.log('Adding files...');
const matrix = await git.statusMatrix({fs, dir});
for (const [filepath, head, workdir, stage] of matrix) {
  try {
    if (workdir === 2 || workdir === 0) {
      if (fs.existsSync(path.join(dir, filepath))) {
        await git.add({fs, dir, filepath});
        console.log(' add', filepath);
      } else {
        await git.remove({fs, dir, filepath});
        console.log(' remove', filepath);
      }
    }
  } catch(e){ console.log(' add err', filepath, e.message)}
}
console.log('Committing...');
let sha = await git.commit({
  fs, dir,
  author: {name: 'Praket', email: 'praket.gauri1234@gmail.com'},
  message: `Remediation: fix all 16 publication blockers

- Fix native Router.cs compilation (remove Command mismatch, add JsonNodes)
- Replace PipeBackend with LiveBackend (BridgeClient v2) in server/http
- Remove set_feed_speed legacy path (only preview/apply)
- Fix mm/rev vs mm/min dimensional bug (units.ts with RPM requirement)
- Make operationId mandatory for mutations (strict schemas)
- Fix verify_change to require exact operationId + quantity
- Add .NET 10 Mastercam 2027 adapter EntryPoint (net10.0-windows)
- Fix BridgeClient cancellation temporal dead zone
- Separate semantic vs transport errors in circuit breaker
- Fix audit chain restart/rotation and credential redaction
- Add real output schemas (no z.unknown)
- Add SBOM generation and secret scanning to release
- Add C# CodeQL analysis
- Add e2e bridge-v2 integration test
- Fix install.ps1 uninstall, bundled dotnet, atomic replace
- Fix cross-platform pipe and framing

Fixes #4`,
});
console.log('Committed', sha);

console.log('Pushing...');
await git.push({fs, http, dir, onAuth: () => auth});
console.log('Pushed');
