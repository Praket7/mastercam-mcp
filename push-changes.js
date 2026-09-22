import { init, addRemote, add, commit, push, fetch, merge } from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'fs';
import path from 'path';

const dir = '/Users/pcg/mastercam-mcp';
const remote = 'origin';
const url = 'https://github.com/Praket7/mastercam-mcp.git';

async function getGhToken() {
  const { execSync } = await import('child_process');
  return execSync('gh auth token', { encoding: 'utf8' }).trim();
}

async function main() {
  try {
    const token = await getGhToken();
    const onAuth = () => ({ username: 'x-access-token', password: token });

    const gitDir = path.join(dir, '.git');
    if (!fs.existsSync(gitDir)) {
      await init({ fs, dir, defaultBranch: 'main' });
      await addRemote({ fs, dir, remote, url });
    }

    await fetch({ fs, http, dir, remote, onAuth });
    try {
      await merge({ fs, dir, theirs: 'origin/main', ours: 'main', fastForwardOnly: true });
    } catch (error) {
      throw new Error(`Refusing to push because local main is not a fast-forward of origin/main: ${error.message}`);
    }

    await add({ fs, dir, filepath: '.' });
    await commit({
      fs,
      dir,
      message: process.env.MASTERCAM_MCP_COMMIT_MESSAGE ?? 'Update mastercam-mcp',
      author: {
        name: 'Praket7',
        email: 'praket7@users.noreply.github.com'
      }
    });

    await push({
      fs,
      http,
      dir,
      remote,
      ref: 'main',
      force: false,
      onAuth
    });

    console.log('Push successful');
  } catch (error) {
    console.error('Push failed:', error.message);
    process.exit(1);
  }
}

main();
