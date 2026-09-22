import { init, addRemote, add, commit, push, fetch, merge } from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'fs';
import path from 'path';

const dir = '/Users/pcg/mastercam-mcp';
const remote = 'origin';
const url = 'https://github.com/Praket7/mastercam-mcp.git';

async function getGhToken() {
  const { execSync } = await import('child_process');
  const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
  return token;
}

async function main() {
  try {
    const token = await getGhToken();
    console.log('Got GitHub token');

    // Check if .git exists
    const gitDir = path.join(dir, '.git');
    if (!fs.existsSync(gitDir)) {
      console.log('Initializing new git repository...');
      await init({ fs, dir, defaultBranch: 'main' });
      await addRemote({ fs, dir, remote, url });
    }

    // Try to fetch and merge first
    console.log('Fetching remote...');
    try {
      await fetch({ fs, http, dir, remote, onAuth: () => ({ username: 'x-access-token', password: token }) });
      console.log('Merging...');
      await merge({ fs, dir, theirs: 'origin/main', ours: 'main', fastForwardOnly: false });
    } catch (e) {
      console.log('Fetch/merge failed, will force push:', e.message);
    }

    console.log('Adding all files...');
    await add({ fs, dir, filepath: "." });

    console.log('Committing...');
    await commit({
      fs,
      dir,
      message: 'Fix P0 architectural issues: unify framing protocol, add output schemas, fix retry/circuit breaker, add acceptance harness, machine profile validation, unified config',
      author: {
        name: 'Praket7',
        email: 'praket7@users.noreply.github.com'
      }
    });

    console.log('Pushing to GitHub (force)...');
    await push({
      fs,
      http,
      dir,
      remote,
      ref: 'main',
      force: true,
      onAuth: () => ({ username: 'x-access-token', password: token })
    });

    console.log('✅ Push successful!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
